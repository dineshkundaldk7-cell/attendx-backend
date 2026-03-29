const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Helper: today's date string in YYYY-MM-DD
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Helper: haversine distance in metres
function calcDist(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── POST /api/attendance/checkin ──────────────────────────
router.post('/checkin', requireAuth, async (req, res) => {
  const { lat, lng, accuracy, photo_url, notes } = req.body;
  const today = todayStr();
  const now = new Date().toISOString();

  // Get office settings
  const { data: settings } = await supabase
    .from('settings').select('*').eq('id', 1).single();

  // Check geofence if office location is set
  let geo_status = 'unverified';
  let dist_metres = null;
  if (settings?.office_lat && lat) {
    dist_metres = Math.round(calcDist(lat, lng, settings.office_lat, settings.office_lng));
    geo_status = dist_metres <= (settings.geo_radius_metres || 200) ? 'inside' : 'outside';
  }

  // Check for existing record today
  const { data: existing } = await supabase
    .from('attendance')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .single();

  if (existing?.check_in_time) {
    return res.status(409).json({ error: 'Already checked in today.' });
  }

  // Determine late status
  let status = 'on_time';
  if (settings?.work_start_time) {
    const [sh, sm] = settings.work_start_time.split(':').map(Number);
    const startMs = new Date(); startMs.setHours(sh, sm, 0, 0);
    const lateThresh = (settings.late_threshold_minutes || 15) * 60000;
    if (new Date() - startMs > lateThresh) status = 'late';
  }

  const record = {
    user_id: req.user.id,
    user_name: req.user.name,
    employee_id: req.user.employee_id || '',
    date: today,
    check_in_time: now,
    check_in_lat: lat,
    check_in_lng: lng,
    check_in_accuracy: accuracy,
    check_in_photo_url: photo_url || null,
    check_in_geo_status: geo_status,
    check_in_dist_metres: dist_metres,
    status,
    notes: notes || null
  };

  const { data, error } = await supabase
    .from('attendance').insert(record).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: `Checked in at ${new Date(now).toLocaleTimeString()} — ${status.replace('_',' ')}`, record: data });
});

// ── POST /api/attendance/checkout ─────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  const { lat, lng, accuracy, photo_url, notes } = req.body;
  const today = todayStr();
  const now = new Date().toISOString();

  const { data: record, error: fetchErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .single();

  if (fetchErr || !record) return res.status(404).json({ error: 'No check-in found for today.' });
  if (record.check_out_time) return res.status(409).json({ error: 'Already checked out today.' });

  const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single();
  let geo_status = 'unverified', dist_metres = null;
  if (settings?.office_lat && lat) {
    dist_metres = Math.round(calcDist(lat, lng, settings.office_lat, settings.office_lng));
    geo_status = dist_metres <= (settings.geo_radius_metres || 200) ? 'inside' : 'outside';
  }

  const checkInMs = new Date(record.check_in_time).getTime();
  const checkOutMs = new Date(now).getTime();
  const hours_worked = parseFloat(((checkOutMs - checkInMs) / 3600000).toFixed(2));

  const { data: updated, error } = await supabase
    .from('attendance')
    .update({
      check_out_time: now,
      check_out_lat: lat,
      check_out_lng: lng,
      check_out_accuracy: accuracy,
      check_out_photo_url: photo_url || null,
      check_out_geo_status: geo_status,
      check_out_dist_metres: dist_metres,
      hours_worked,
      notes: notes || record.notes
    })
    .eq('id', record.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: `Checked out — ${hours_worked} hours worked.`, record: updated });
});

// ── GET /api/attendance/today ─────────────────────────────
// Employee: own record. Admin: all records.
router.get('/today', requireAuth, async (req, res) => {
  const today = todayStr();
  let query = supabase.from('attendance').select('*').eq('date', today);
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  query = query.order('check_in_time', { ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/attendance/my-history ───────────────────────
router.get('/my-history', requireAuth, async (req, res) => {
  const { from, to, limit = 30 } = req.query;
  let query = supabase.from('attendance').select('*').eq('user_id', req.user.id);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);
  query = query.order('date', { ascending: false }).limit(parseInt(limit));
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/attendance/records (admin) ───────────────────
router.get('/records', requireAdmin, async (req, res) => {
  const { from, to, user_id, date, limit = 100 } = req.query;
  let query = supabase.from('attendance').select('*');
  if (date) query = query.eq('date', date);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);
  if (user_id) query = query.eq('user_id', user_id);
  query = query.order('date', { ascending: false }).order('check_in_time', { ascending: false }).limit(parseInt(limit));
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/attendance/:id (admin) ────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('attendance').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Record deleted.' });
});

// ── PATCH /api/attendance/:id (admin: manual correction) ──
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['check_in_time', 'check_out_time', 'status', 'notes', 'hours_worked'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.check_in_time && updates.check_out_time) {
    updates.hours_worked = parseFloat(
      ((new Date(updates.check_out_time) - new Date(updates.check_in_time)) / 3600000).toFixed(2)
    );
  }
  const { data, error } = await supabase
    .from('attendance').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
