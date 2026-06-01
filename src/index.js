// Only load dotenv in development (Render sets env vars automatically)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const billingRoutes = require('./routes/billing');
const dashboardRoutes = require('./routes/dashboard');
const { startCronJobs } = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

// IMPORTANT: Stripe webhook needs raw body — register it BEFORE json parser
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// JSON parser for all other routes
app.use(express.json());

// Trust proxy for rate limiting behind reverse proxy (e.g., on Render)
app.set('trust proxy', 1);

// CORS — allow frontend origin (multiple origins for flexibility)
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://chimpsweep-frontend.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
}));

// Basic rate limiting — 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Health check endpoint (for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BillingSaver backend running on port ${PORT}`);
  startCronJobs();
});

module.exports = app;
