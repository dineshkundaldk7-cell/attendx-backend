require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const supabase = require('./config/supabase');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — prevent brute force on login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});
app.use('/api/auth/login', loginLimiter);

// General API rate limit
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 200 });
app.use('/api/', apiLimiter);

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api', require('./routes/settings')); // for /api/upload/photo

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error. Please try again.' });
});

// ── Seed admin account on first start ─────────────────────
async function seedAdmin() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  const { data } = await supabase.from('users').select('id').eq('email', process.env.ADMIN_EMAIL).single();
  if (!data) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await supabase.from('users').insert({
      name: process.env.ADMIN_NAME || 'Administrator',
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      password_hash: hash,
      role: 'admin',
      employee_id: 'ADMIN-001',
      department: 'Administration',
      designation: 'System Admin',
      is_active: true
    });
    console.log(`✅ Admin account created: ${process.env.ADMIN_EMAIL}`);
  }

  // Seed default settings row if missing
  const { data: settings } = await supabase.from('settings').select('id').eq('id', 1).single();
  if (!settings) {
    await supabase.from('settings').insert({
      id: 1,
      office_name: 'My Office',
      geo_radius_metres: 200,
      work_start_time: '09:00',
      work_end_time: '18:00',
      late_threshold_minutes: 15,
      timezone: 'Asia/Kolkata'
    });
    console.log('✅ Default settings created.');
  }
}

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 AttendX backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  await seedAdmin();
  console.log('   Ready.\n');
});
