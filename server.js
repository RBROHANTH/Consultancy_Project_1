/**
 * VFC Agro Foods — Express Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage : MongoDB Atlas (mongoose)
 * Features:
 *   • Contact form  → email + saved to MongoDB
 *   • Dealer form   → email + saved to MongoDB
 *   • Rate limiting → 5 submissions per IP per 15 min
 *   • Admin API     → GET/DELETE /admin/enquiries (password-protected)
 *   • Admin UI      → GET /admin
 * ─────────────────────────────────────────────────────────────────────────────
 * Required .env keys:
 *   MONGODB_URI         MongoDB Atlas connection string
 *   GMAIL_USER          your Gmail address
 *   GMAIL_APP_PASSWORD  16-char Google App Password
 *   RECIPIENT_EMAIL     where emails land
 *   ADMIN_PASSWORD      password to access /admin dashboard
 *   PORT                (optional, default 3000)
 */

'use strict';

const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const path       = require('path');
const mongoose   = require('mongoose');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✓  MongoDB Atlas connected'))
    .catch(err => {
        console.error('✗  MongoDB connection error:', err.message);
        console.log('\nMake sure MONGODB_URI is set in your .env file.');
        console.log('Format: mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority');
    });

// ─── Mongoose Schema & Model ──────────────────────────────────────────────────
const enquirySchema = new mongoose.Schema({
    // Common fields
    id:        { type: String, required: true, unique: true },
    type:      { type: String, enum: ['contact', 'dealer'], required: true },
    ip:        { type: String, default: '' },

    // Contact form fields
    from_name:  String,
    from_email: String,
    subject:    String,
    message:    String,

    // Dealer form fields
    business_name:  String,
    contact_person: String,
    phone:          String,
    email:          String,
    city:           String,
    order_quantity: String,
    flavors:        String,

}, {
    timestamps: true   // adds createdAt & updatedAt automatically
});

const Enquiry = mongoose.model('Enquiry', enquirySchema);

// ─── In-memory rate limiter ───────────────────────────────────────────────────
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT     = 5;
const rateMap        = new Map();

function getRealIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.socket.remoteAddress
        || 'unknown';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const rec = rateMap.get(ip) || { count: 0, windowStart: now };
    if (now - rec.windowStart > RATE_WINDOW_MS) { rec.count = 0; rec.windowStart = now; }
    rec.count++;
    rateMap.set(ip, rec);
    return {
        allowed:   rec.count <= RATE_LIMIT,
        remaining: Math.max(0, RATE_LIMIT - rec.count),
        resetIn:   Math.ceil((rec.windowStart + RATE_WINDOW_MS - now) / 60000)
    };
}

setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [ip, rec] of rateMap.entries()) {
        if (rec.windowStart < cutoff) rateMap.delete(ip);
    }
}, 60 * 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ─── Nodemailer transporter ───────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    tls:  { rejectUnauthorized: false }
});

transporter.verify(err =>
    err ? console.error('✗  SMTP error:', err.message)
        : console.log('✓  SMTP server ready')
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formRateLimiter(req, res, next) {
    const result = checkRateLimit(getRealIP(req));
    if (!result.allowed)
        return res.status(429).json({ success: false,
            error: `Too many submissions. Please wait ${result.resetIn} minute(s).` });
    next();
}

function sanitize(str = '') {
    return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

function buildEmailHTML({ title, rows, messageLabel, message, footerNote }) {
    const rowsHTML = rows.map(([label, value], i) => `
        <tr style="${i % 2 ? 'background:#f8f9fa;' : ''}">
            <td style="padding:10px 14px;font-weight:600;color:#1d3557;white-space:nowrap;">${label}</td>
            <td style="padding:10px 14px;">${value}</td>
        </tr>`).join('');
    return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#1d3557,#457b9d);padding:28px 32px;">
            <h2 style="color:#fff;margin:0;font-size:1.3rem;">${title}</h2>
            <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:0.85rem;">VFC Agro Food Products Pvt. Ltd</p>
        </div>
        <div style="padding:24px 32px;">
            <table style="width:100%;border-collapse:collapse;">${rowsHTML}</table>
            <div style="margin-top:24px;padding:20px;background:#f8f9fa;border-left:4px solid #f77f00;border-radius:4px;">
                <h3 style="color:#1d3557;margin:0 0 10px;font-size:1rem;">${messageLabel}</h3>
                <p style="line-height:1.7;margin:0;white-space:pre-wrap;color:#333;">${message}</p>
            </div>
        </div>
        <div style="background:#f1f3f5;padding:14px 32px;font-size:11px;color:#999;">
            ${footerNote} &nbsp;|&nbsp; ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST
        </div>
    </div>`;
}

function requireAdmin(req, res, next) {
    const provided = req.headers['x-admin-password'] || req.query.p;
    if (!process.env.ADMIN_PASSWORD)
        return res.status(503).json({ error: 'ADMIN_PASSWORD not set in .env' });
    if (provided !== process.env.ADMIN_PASSWORD)
        return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ─── POST /send-email  (contact form) ────────────────────────────────────────
app.post('/send-email', formRateLimiter, async (req, res) => {
    const from_name  = sanitize(req.body.from_name);
    const from_email = sanitize(req.body.from_email);
    const subject    = sanitize(req.body.subject);
    const message    = sanitize(req.body.message);

    if (!from_name || !from_email || !message)
        return res.status(400).json({ success: false, error: 'Name, email, and message are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from_email))
        return res.status(400).json({ success: false, error: 'Invalid email address.' });

    try {
        await transporter.sendMail({
            from: `"${from_name}" <${process.env.GMAIL_USER}>`,
            replyTo: from_email,
            to: process.env.RECIPIENT_EMAIL,
            subject: subject || `New enquiry from ${from_name}`,
            html: buildEmailHTML({
                title: '📩 New Contact Form Enquiry',
                rows:  [['Name', from_name], ['Email', `<a href="mailto:${from_email}">${from_email}</a>`], ['Subject', subject || 'N/A']],
                messageLabel: 'Message', message,
                footerNote: 'VFC Agro Foods — Contact Form'
            })
        });

        // Save to MongoDB
        await Enquiry.create({
            id:         `ENQ-${Date.now()}`,
            type:       'contact',
            from_name, from_email,
            subject:    subject || '',
            message,
            ip:         getRealIP(req)
        });

        res.json({ success: true, message: 'Message sent successfully!' });
    } catch (err) {
        console.error('Contact error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to send. Please try again later.' });
    }
});

// ─── POST /dealer-enquiry ─────────────────────────────────────────────────────
app.post('/dealer-enquiry', formRateLimiter, async (req, res) => {
    const business_name  = sanitize(req.body.business_name);
    const contact_person = sanitize(req.body.contact_person);
    const phone          = sanitize(req.body.phone);
    const email          = sanitize(req.body.email);
    const city           = sanitize(req.body.city);
    const order_quantity = sanitize(req.body.order_quantity);
    const flavors        = sanitize(req.body.flavors);
    const message        = sanitize(req.body.message);

    if (!business_name || !contact_person || !phone || !city || !order_quantity)
        return res.status(400).json({ success: false, error: 'Please fill all required fields.' });

    try {
        await transporter.sendMail({
            from: `"${business_name}" <${process.env.GMAIL_USER}>`,
            replyTo: email || process.env.GMAIL_USER,
            to: process.env.RECIPIENT_EMAIL,
            subject: `🏪 Dealer Enquiry — ${business_name}, ${city}`,
            html: buildEmailHTML({
                title: '🏪 New Dealer / Bulk Order Enquiry',
                rows: [
                    ['Business Name',  business_name],
                    ['Contact Person', contact_person],
                    ['Phone',          phone],
                    ['Email',          email ? `<a href="mailto:${email}">${email}</a>` : 'N/A'],
                    ['City',           city],
                    ['Order Quantity', order_quantity],
                    ['Flavors Wanted', flavors || 'Not specified'],
                ],
                messageLabel: 'Additional Notes', message: message || '(none)',
                footerNote: 'VFC Agro Foods — Dealer Enquiry Form'
            })
        });

        // Save to MongoDB
        await Enquiry.create({
            id:             `DEL-${Date.now()}`,
            type:           'dealer',
            business_name, contact_person, phone,
            email:          email || '',
            city, order_quantity,
            flavors:        flavors || '',
            message:        message || '',
            ip:             getRealIP(req)
        });

        res.json({ success: true, message: 'Enquiry submitted! We will contact you within 24 hours.' });
    } catch (err) {
        console.error('Dealer error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to submit. Please try again later.' });
    }
});

// ─── GET /admin/enquiries ─────────────────────────────────────────────────────
app.get('/admin/enquiries', requireAdmin, async (req, res) => {
    try {
        const filter = req.query.type ? { type: req.query.type } : {};
        const limit  = parseInt(req.query.limit) || 200;
        const enquiries = await Enquiry.find(filter)
            .sort({ createdAt: -1 })   // newest first
            .limit(limit)
            .lean();

        // Normalise: add a timestamp field that admin.html expects
        const normalised = enquiries.map(e => ({
            ...e,
            timestamp: e.createdAt?.toISOString() || ''
        }));

        res.json({ total: normalised.length, enquiries: normalised });
    } catch (err) {
        console.error('Admin fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch enquiries.' });
    }
});

// ─── DELETE /admin/enquiries/:id ─────────────────────────────────────────────
app.delete('/admin/enquiries/:id', requireAdmin, async (req, res) => {
    try {
        const result = await Enquiry.deleteOne({ id: req.params.id });
        if (result.deletedCount === 0)
            return res.status(404).json({ error: 'Enquiry not found.' });
        res.json({ success: true, deleted: req.params.id });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed.' });
    }
});

// ─── DELETE /admin/enquiries/all ─────────────────────────────────────────────
app.delete('/admin/enquiries/all', requireAdmin, async (req, res) => {
    try {
        await Enquiry.deleteMany({});
        res.json({ success: true, message: 'All enquiries deleted.' });
    } catch (err) {
        res.status(500).json({ error: 'Clear all failed.' });
    }
});

// ─── GET /admin ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀  VFC server running at http://localhost:${PORT}`);
    console.log(`📋  Admin dashboard → http://localhost:${PORT}/admin\n`);
});
