require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 8000;

// ── Database Connection (Supabase) ────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Middleware ────────────────────────────────────────────
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: 'https://lxvemedz.github.io' }));

// ── Server-side pricing (single source of truth) ─────────
const SESSIONS = {
  1: { name: '1-Hour Block', hours: 1, price: 3000,  deposit: 3000  },
  2: { name: '2-Hour Block', hours: 2, price: 6000,  deposit: 3000  },
  3: { name: 'Half Day',     hours: 4, price: 12000, deposit: 6000  },
  4: { name: 'Full Day',     hours: 8, price: 24000, deposit: 12000 },
};

// ── POST /api/create-checkout-session ─────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const {
      sessionId, clientName, clientEmail,
      date, time, notes, dateKey, startHour, hours,
    } = req.body;

    const session = SESSIONS[Number(sessionId)];
    if (!session) return res.status(400).json({ error: 'Invalid session type' });

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name:        `${session.name} — Medz on the Mix`,
            description: `Session on ${date} at ${time}`,
          },
          unit_amount: session.deposit,
        },
        quantity: 1,
      }],
      mode:           'payment',
      success_url:    `https://lxvemedz.github.io/Medz-On-The-Mix?booked=true`,
      cancel_url:     `https://lxvemedz.github.io/Medz-On-The-Mix?cancelled=true`,
      customer_email: clientEmail,
      metadata: {
        clientName:  clientName.slice(0, 499),
        clientEmail: clientEmail.slice(0, 499),
        sessionName: session.name,
        total:       String(session.price / 100),
        deposit:     String(session.deposit / 100),
        balance:     String((session.price - session.deposit) / 100),
        date:        date.slice(0, 499),
        time:        time.slice(0, 499),
        notes:       (notes || '').slice(0, 499),
        dateKey,
        startHour:   String(startHour),
        hours:       String(hours),
      },
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe-webhook ──────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Payment confirmed: send email + save to Supabase ───
  if (event.type === 'checkout.session.completed') {
    const checkoutSession = event.data.object;
    const m = checkoutSession.metadata;
    const paymentIntentId = checkoutSession.payment_intent;

    console.log(`Payment confirmed for ${m.clientName} — ${m.sessionName} on ${m.date}`);

    try {
      // 1. Send EmailJS Confirmation
      const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id:  process.env.EMAILJS_SERVICE_ID,
          template_id: process.env.EMAILJS_TEMPLATE_ID,
          user_id:     process.env.EMAILJS_PUBLIC_KEY,
          template_params: {
            email:        m.clientEmail,
            client_name:  m.clientName,
            session_name: m.sessionName,
            session_date: m.date,
            session_time: m.time,
            deposit:      `$${m.deposit}`,
            balance:      `$${m.balance} due day of`,
          },
        }),
      });

      const body = await emailRes.text();
      if (!emailRes.ok) {
        console.error('EmailJS error:', emailRes.status, body);
      } else {
        console.log('Confirmation email sent to', m.clientEmail);
      }

      // 2. Save booking to Supabase — includes payment_intent_id for refund tracking
      const insertQuery = `
        INSERT INTO "Bookings" (date, start_time, client_name, client_email, session_name, session_hours, payment_intent_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      const values = [
        m.date, m.time, m.clientName, m.clientEmail,
        m.sessionName, parseInt(m.hours), paymentIntentId
      ];

      await pool.query(insertQuery, values);
      console.log('Booking saved to Supabase:', m.sessionName, m.date, m.time);

    } catch (err) {
      console.error('Failed to process completed booking:', err.message);
    }
  }

  // ── Full refund: remove booking from Supabase so slot opens back up ───
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;

    // Only remove the slot if it was a FULL refund
    if (charge.refunded) {
      const paymentIntentId = charge.payment_intent;
      try {
        const result = await pool.query(
          'DELETE FROM "Bookings" WHERE payment_intent_id = $1',
          [paymentIntentId]
        );
        console.log(`Booking removed after full refund — payment_intent: ${paymentIntentId}`);
      } catch (err) {
        console.error('Failed to remove booking after refund:', err.message);
      }
    } else {
      console.log('Partial refund detected — slot remains blocked.');
    }
  }

  // ── Refund: release the time slot back ──────────────────
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;

    // Only release slot on FULL refund
    if (charge.amount_refunded !== charge.amount) {
      console.log('Partial refund — slot not released');
      return res.json({ received: true });
    }

    try {
      // Look up the checkout session via payment intent to get booking metadata
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: charge.payment_intent,
        limit: 1,
      });

      if (sessions.data.length > 0) {
        const m = sessions.data[0].metadata;
        await pool.query(
          'DELETE FROM "Bookings" WHERE date = $1 AND start_time = $2',
          [m.date, m.time]
        );
        console.log(`Slot released after refund: ${m.date} at ${m.time}`);
      }
    } catch (err) {
      console.error('Failed to release slot after refund:', err.message);
    }
  }

  res.json({ received: true });
});

// ── GET /api/booked-slots ─────────────────────────────────
app.get('/api/booked-slots', async (req, res) => {
  try {
    const result = await pool.query('SELECT date, start_time, session_hours FROM "Bookings"');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'Medz on the Mix API' }));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Medz on the Mix backend running on port ${PORT}`);
});
