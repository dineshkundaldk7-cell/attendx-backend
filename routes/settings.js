const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── GET /api/settings ─────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  // Don't expose sensitive fields to non-admins
  if (req.user.role !== 'admin') {
    const { office_name, office_address, work_start_time, work_end_time, late_threshold_minutes, geo_radius_metres } = data || {};
    return res.json({ office_name, office_address, work_start_time, work_end_time, late_threshold_minutes, geo_radius_metres });
  }
  res.json(data);
});

// ── PUT /api/settings (admin) ─────────────────────────────
router.put('/', requireAdmin, async (req, res) => {
  const {
    office_name, office_address,
    office_lat, office_lng,
    geo_radius_metres,
    work_start_time, work_end_time,
    late_threshold_minutes,
    timezone
  } = req.body;

  const updates = {
    office_name, office_address,
    office_lat, office_lng,
    geo_radius_metres: parseInt(geo_radius_metres) || 200,
    work_start_time, work_end_time,
    late_threshold_minutes: parseInt(late_threshold_minutes) || 15,
    timezone: timezone || 'Asia/Kolkata',
    updated_at: new Date().toISOString()
  };

  // Upsert (insert if row with id=1 doesn't exist, update if it does)
  const { data, error } = await supabase
    .from('settings')
    .upsert({ id: 1, ...updates })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/upload/photo ────────────────────────────────
// Accepts a photo file and returns a public URL
router.post('/upload/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo file provided.' });

  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const filename = `attendance/${req.user.id}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('photos')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (error) return res.status(500).json({ error: 'Photo upload failed: ' + error.message });

  const { data: { publicUrl } } = supabase.storage.from('photos').getPublicUrl(filename);
  res.json({ url: publicUrl, filename });
});

module.exports = router;
