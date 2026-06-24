// Load environment variables first — before any other require
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');

const connectDB      = require('./config/db');
const memoriesRouter = require('./routes/memories');
const scanRouter     = require('./routes/scan');
const errorHandler   = require('./middleware/errorHandler');

// ── Connect to MongoDB ───────────────────────────────────────────────────────
connectDB();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── Gzip responses ───────────────────────────────────────────────────────────
app.use(compression());

// ── Request logging (development only) ───────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ── CORS — allow Cloudflare Pages domain + local dev origins ─────────────────
const allowedOrigins = [
  'https://memoria-ar.pages.dev',        // production Cloudflare Pages domain
  /^https:\/\/.*\.memoria-ar\.pages\.dev$/, // preview deployments
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server or same-origin requests (no Origin header)
      if (!origin) return callback(null, true);

      const allowed = allowedOrigins.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin)
      );
      if (allowed) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} is not allowed`));
    },
    methods:            ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:     ['Content-Type', 'Authorization'],
    exposedHeaders:     ['Content-Length'],
    credentials:        true,
    optionsSuccessStatus: 200, // Safari compat
  })
);

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General limit: 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests — please try again later' },
});

// Strict limit on upload route: 10 per minute per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many uploads — please wait a moment' },
});

app.use(generalLimiter);
app.use('/api/memories/upload', uploadLimiter);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
  });
});

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/memories', memoriesRouter);
app.use('/api/scan',     scanRouter);

// ── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success:   false,
    message:   `Route not found: ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  });
});

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(errorHandler);

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Memoria AR backend running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
});
