const express = require('express');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

function fmtHours(h) {
  if (!h || h <= 0) return '—';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${mins}m`;
}

// ── GET /api/reports/summary?period=daily|weekly|monthly&date=YYYY-MM-DD ──
router.get('/summary', requireAdmin, async (req, res) => {
  const { period = 'daily', date } = req.query;
  const baseDate = date ? new Date(date) : new Date();
  let from, to;

  if (period === 'daily') {
    from = to = baseDate.toISOString().slice(0, 10);
  } else if (period === 'weekly') {
    const day = baseDate.getDay();
    const mon = new Date(baseDate);
    mon.setDate(baseDate.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0, 10);
    to = sun.toISOString().slice(0, 10);
  } else {
    from = `${baseDate.getFullYear()}-${String(baseDate.getMonth()+1).padStart(2,'0')}-01`;
    const lastDay = new Date(baseDate.getFullYear(), baseDate.getMonth()+1, 0);
    to = lastDay.toISOString().slice(0, 10);
  }

  const [attRes, usersRes] = await Promise.all([
    supabase.from('attendance').select('*').gte('date', from).lte('date', to).order('date'),
    supabase.from('users').select('id, name, employee_id, department, designation').eq('is_active', true).eq('role', 'employee')
  ]);

  const records = attRes.data || [];
  const employees = usersRes.data || [];

  // Build date range
  const dates = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0,10));
    cur.setDate(cur.getDate() + 1);
  }
  const workdays = dates.filter(d => { const day = new Date(d).getDay(); return day !== 0 && day !== 6; });

  // Per-employee stats
  const empStats = employees.map(emp => {
    const empRecs = records.filter(r => r.user_id === emp.id);
    const present = empRecs.filter(r => r.check_in_time).length;
    const late = empRecs.filter(r => r.status === 'late').length;
    const totalHours = empRecs.reduce((s, r) => s + (r.hours_worked || 0), 0);
    return {
      ...emp,
      present,
      absent: Math.max(0, workdays.length - present),
      late,
      total_hours: parseFloat(totalHours.toFixed(2)),
      avg_hours: present > 0 ? parseFloat((totalHours / present).toFixed(2)) : 0,
      attendance_rate: workdays.length > 0 ? Math.round(present / workdays.length * 100) : 0
    };
  });

  // Daily breakdown
  const dailyBreakdown = workdays.map(d => {
    const dayRecs = records.filter(r => r.date === d);
    return {
      date: d,
      present: dayRecs.filter(r => r.check_in_time).length,
      late: dayRecs.filter(r => r.status === 'late').length,
      total_employees: employees.length
    };
  });

  const totalPresent = records.filter(r => r.check_in_time).length;
  const expected = employees.length * workdays.length;
  const totalHours = records.reduce((s, r) => s + (r.hours_worked || 0), 0);
  const checkedOut = records.filter(r => r.hours_worked).length;

  res.json({
    period, from, to,
    summary: {
      total_employees: employees.length,
      workdays: workdays.length,
      total_present: totalPresent,
      overall_attendance_rate: expected > 0 ? Math.round(totalPresent / expected * 100) : 0,
      avg_hours_per_day: checkedOut > 0 ? parseFloat((totalHours / checkedOut).toFixed(2)) : 0,
      total_late: records.filter(r => r.status === 'late').length
    },
    employees: empStats,
    daily_breakdown: dailyBreakdown,
    records
  });
});

// ── POST /api/reports/email ───────────────────────────────
router.post('/email', requireAdmin, async (req, res) => {
  const { to, period = 'daily', date } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required.' });

  // Fetch report data (reuse summary logic via internal call)
  const baseDate = date ? new Date(date) : new Date();
  let from, toDate;
  if (period === 'daily') {
    from = toDate = baseDate.toISOString().slice(0,10);
  } else if (period === 'weekly') {
    const day = baseDate.getDay();
    const mon = new Date(baseDate); mon.setDate(baseDate.getDate() - (day === 0 ? 6 : day-1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = mon.toISOString().slice(0,10);
    toDate = sun.toISOString().slice(0,10);
  } else {
    from = `${baseDate.getFullYear()}-${String(baseDate.getMonth()+1).padStart(2,'0')}-01`;
    toDate = new Date(baseDate.getFullYear(), baseDate.getMonth()+1, 0).toISOString().slice(0,10);
  }

  const [attRes, usersRes, settingsRes] = await Promise.all([
    supabase.from('attendance').select('*').gte('date', from).lte('date', toDate).order('date'),
    supabase.from('users').select('*').eq('is_active', true).eq('role', 'employee'),
    supabase.from('settings').select('*').eq('id', 1).single()
  ]);

  const records = attRes.data || [];
  const employees = usersRes.data || [];
  const settings = settingsRes.data || {};

  const dates = [];
  const cur = new Date(from);
  const end = new Date(toDate);
  while (cur <= end) { dates.push(cur.toISOString().slice(0,10)); cur.setDate(cur.getDate()+1); }
  const workdays = dates.filter(d => { const day = new Date(d).getDay(); return day !== 0 && day !== 6; });

  const totalPresent = records.filter(r => r.check_in_time).length;
  const expected = employees.length * workdays.length;
  const rate = expected > 0 ? Math.round(totalPresent / expected * 100) : 0;

  const empRows = employees.map(emp => {
    const empRecs = records.filter(r => r.user_id === emp.id && r.check_in_time);
    const late = records.filter(r => r.user_id === emp.id && r.status === 'late').length;
    const totalH = empRecs.reduce((s, r) => s + (r.hours_worked || 0), 0);
    const pct = workdays.length > 0 ? Math.round(empRecs.length / workdays.length * 100) : 0;
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:8px 12px">${emp.name}</td>
      <td style="padding:8px 12px;color:#666">${emp.department || '—'}</td>
      <td style="padding:8px 12px;text-align:center">${empRecs.length}/${workdays.length}</td>
      <td style="padding:8px 12px;text-align:center;color:${pct >= 80 ? '#1a6b3a' : pct >= 60 ? '#d4770a' : '#e8460a'};font-weight:600">${pct}%</td>
      <td style="padding:8px 12px;text-align:center;color:#d4770a">${late}</td>
      <td style="padding:8px 12px;text-align:center">${fmtHours(totalH)}</td>
    </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;background:#f4f1eb;margin:0;padding:20px">
<div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#0a0a0f;padding:32px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:28px;letter-spacing:-1px">Attend<span style="color:#e8460a">X</span></h1>
    <p style="color:#888;margin:6px 0 0;font-size:14px">${period.charAt(0).toUpperCase()+period.slice(1)} Attendance Report</p>
  </div>
  <div style="padding:32px">
    <p style="color:#666;font-size:14px;margin-bottom:24px">
      <strong>Office:</strong> ${settings.office_name || 'Office'} &nbsp;|&nbsp;
      <strong>Period:</strong> ${from} ${from !== toDate ? '→ ' + toDate : ''} &nbsp;|&nbsp;
      <strong>Generated:</strong> ${new Date().toLocaleString()}
    </p>
    <div style="display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap">
      ${[
        ['Overall Attendance', rate + '%', rate >= 80 ? '#d1f5e0' : '#fde8e0'],
        ['Total Present', totalPresent + ' / ' + expected, '#e8f0fe'],
        ['Work Days', workdays.length, '#fdecd1'],
        ['Late Arrivals', records.filter(r => r.status === 'late').length, '#fde8e0']
      ].map(([label, val, bg]) => `
        <div style="flex:1;min-width:140px;background:${bg};border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:6px">${label}</div>
          <div style="font-size:24px;font-weight:700;color:#0a0a0f">${val}</div>
        </div>`).join('')}
    </div>
    <h3 style="color:#0a0a0f;border-bottom:2px solid #f0ece4;padding-bottom:8px;margin-bottom:16px">Employee Breakdown</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f4f1eb">
          <th style="padding:10px 12px;text-align:left;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Employee</th>
          <th style="padding:10px 12px;text-align:left;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Dept</th>
          <th style="padding:10px 12px;text-align:center;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Days Present</th>
          <th style="padding:10px 12px;text-align:center;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Rate</th>
          <th style="padding:10px 12px;text-align:center;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Late</th>
          <th style="padding:10px 12px;text-align:center;color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase">Hours</th>
        </tr>
      </thead>
      <tbody>${empRows}</tbody>
    </table>
  </div>
  <div style="background:#f4f1eb;padding:20px;text-align:center;font-size:12px;color:#aaa">
    Sent automatically by AttendX &nbsp;·&nbsp; Do not reply to this email
  </div>
</div>
</body></html>`;

  // Send email
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT),
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: `AttendX ${period.charAt(0).toUpperCase()+period.slice(1)} Report — ${from}${from !== toDate ? ' to ' + toDate : ''}`,
      html
    });
    res.json({ message: `Report sent to ${to}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send email: ' + e.message });
  }
});

module.exports = router;
