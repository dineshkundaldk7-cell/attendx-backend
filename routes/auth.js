const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/login ──────────────────────────────────
// Body: { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error || !user)
    return res.status(401).json({ error: 'Invalid email or password.' });

  if (!user.is_active)
    return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match)
    return res.status(401).json({ error: 'Invalid email or password.' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  // Update last login
  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, employee_id: user.employee_id }
  });
});

// ── POST /api/auth/change-password ──────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Both current and new password are required.' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(newPassword, 12);
  await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);
  res.json({ message: 'Password changed successfully.' });
});

// ── GET /api/auth/me ─────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email, role, employee_id, department, designation, created_at, last_login')
    .eq('id', req.user.id)
    .single();
  res.json(user);
});

// ── POST /api/auth/users  (admin: create employee accounts) ──
router.post('/users', requireAdmin, async (req, res) => {
  const { name, email, password, role = 'employee', employee_id, department, designation } = req.body;
  if (!name || !email || !password || !employee_id)
    return res.status(400).json({ error: 'name, email, password, employee_id are required.' });

  const exists = await supabase.from('users').select('id').eq('email', email.toLowerCase()).single();
  if (exists.data) return res.status(409).json({ error: 'Email already registered.' });

  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.from('users').insert({
    name, email: email.toLowerCase().trim(), password_hash: hash,
    role, employee_id, department, designation, is_active: true
  }).select('id, name, email, role, employee_id, department, designation').single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── GET /api/auth/users  (admin: list all users) ─────────
router.get('/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, employee_id, department, designation, is_active, created_at, last_login')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/auth/users/:id  (admin: update/deactivate) ──
router.patch('/users/:id', requireAdmin, async (req, res) => {
  const { name, department, designation, role, is_active, password } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (department !== undefined) updates.department = department;
  if (designation !== undefined) updates.designation = designation;
  if (role !== undefined) updates.role = role;
  if (is_active !== undefined) updates.is_active = is_active;
  if (password) updates.password_hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.params.id)
    .select('id, name, email, role, employee_id, department, designation, is_active').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
