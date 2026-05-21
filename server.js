const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

app.use(cors());
app.use(express.json());

// Email setup
let emailTransporter = null;

const setupEmail = async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    emailTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
    console.log('✅ Email system ready');
  } catch (err) {
    console.log('⚠️ Email disabled');
  }
};
setupEmail();

const db = new sqlite3.Database('./gse_inventory.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'storekeeper',
    email TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_number TEXT UNIQUE NOT NULL,
    description TEXT,
    manufacturer TEXT,
    compatible_gse TEXT,
    location_bin TEXT,
    quantity_on_hand INTEGER DEFAULT 0,
    min_stock INTEGER DEFAULT 5,
    contact_person TEXT,
    contact_phone TEXT,
    contact_email TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id INTEGER,
    transaction_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    gse_registration TEXT,
    technician_name TEXT,
    work_order TEXT,
    reference_number TEXT,
    created_by TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ========== LOGIN ==========
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    if (bcrypt.compareSync(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY);
      res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });
});

// ========== PARTS ==========
app.get('/api/parts', authenticateToken, (req, res) => {
  db.all('SELECT * FROM parts ORDER BY part_number', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/transactions/receive', authenticateToken, (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  db.get('SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', [part_number], (err, part) => {
    if (err || !part) return res.status(404).json({ error: 'Part not found' });
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(`INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)`, [part.id, 'RECEIVE', quantity, reference_number, notes, req.user.username]);
      db.run(`UPDATE parts SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?`, [quantity, part.id]);
      db.run('COMMIT', (err) => {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
        res.json({ message: 'Parts received successfully' });
      });
    });
  });
});

app.post('/api/transactions/issue', authenticateToken, (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  db.get('SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', [part_number], (err, part) => {
    if (err || !part) return res.status(404).json({ error: 'Part not found' });
    if (part.quantity_on_hand < quantity) return res.status(400).json({ error: 'Insufficient stock' });
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(`INSERT INTO transactions (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [part.id, 'ISSUE', quantity, gse_registration, technician_name, work_order, notes, req.user.username]);
      db.run(`UPDATE parts SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?`, [quantity, part.id]);
      db.run('COMMIT', (err) => {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
        res.json({ message: 'Parts issued successfully' });
      });
    });
  });
});

app.get('/api/transactions', authenticateToken, (req, res) => {
  db.all(`SELECT t.*, p.part_number, p.description FROM transactions t JOIN parts p ON t.part_id = p.id ORDER BY t.created_at DESC LIMIT 50`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/reports/low-stock', authenticateToken, (req, res) => {
  db.all(`SELECT part_number, description, quantity_on_hand, min_stock, location_bin FROM parts WHERE quantity_on_hand <= min_stock`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ========== CREATE PART - WITH CONTACT DETAILS ==========
app.post('/api/parts', authenticateToken, (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, contact_person, contact_phone, contact_email } = req.body;
  
  db.run(`INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand, contact_person, contact_phone, contact_email)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [part_number, description, manufacturer, compatible_gse, location_bin, min_stock || 5, contact_person, contact_phone, contact_email],
    function(err) {
      if (err) return res.status(500).json({ error: 'Part number already exists' });
      res.json({ id: this.lastID, message: 'Part created successfully' });
    }
  );
});

// ========== UPDATE PART - ALL USERS CAN EDIT CONTACT ==========
app.put('/api/parts/:id', authenticateToken, (req, res) => {
  const { contact_person, contact_phone, contact_email, location_bin, min_stock } = req.body;
  
  db.run(`UPDATE parts SET 
          contact_person = ?, 
          contact_phone = ?, 
          contact_email = ?, 
          location_bin = ?,
          min_stock = ?
          WHERE id = ?`,
    [contact_person, contact_phone, contact_email, location_bin, min_stock, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Part updated successfully' });
    }
  );
});

// ========== DELETE PART - Admin AND Manager ==========
app.delete('/api/parts/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  db.run('DELETE FROM parts WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Part deleted successfully' });
  });
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.all('SELECT id, username, full_name, role, email FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const password_hash = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, [username, password_hash, full_name, role || 'storekeeper', email || null], function(err) {
    if (err) return res.status(500).json({ error: 'Username already exists' });
    res.json({ id: this.lastID, message: 'User created successfully' });
  });
});

app.put('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, role, email } = req.body;
  db.run('UPDATE users SET full_name = ?, role = ?, email = ? WHERE id = ?', [full_name, role, email, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'User updated successfully' });
  });
});

app.delete('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'User deleted successfully' });
  });
});

app.post('/api/change-password', authenticateToken, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    const new_hash = bcrypt.hashSync(new_password, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [new_hash, req.user.id], function(err) {
      if (err) return res.status(500).json({ error: 'Failed to update password' });
      res.json({ message: 'Password changed successfully! Please login again.' });
    });
  });
});

app.post('/api/admin/reset-password', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { user_id, new_password } = req.body;
  if (!user_id || !new_password) return res.status(400).json({ error: 'User ID and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const new_hash = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [new_hash, user_id], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to reset password' });
    res.json({ message: 'Password reset successfully!' });
  });
});

// ========== FORGOT PASSWORD ==========
const resetCodes = new Map();

app.post('/api/forgot-password', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  db.get('SELECT id, username, email FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user) return res.json({ message: 'If account exists, reset code has been sent.' });
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(user.username, { code: resetCode, expires: Date.now() + 3600000 });
    console.log(`\n🔐 RESET CODE FOR ${username}: ${resetCode}`);
    if (user.email && emailTransporter) {
      emailTransporter.sendMail({
        from: '"GSE Inventory" <noreply@gse.com>',
        to: user.email,
        subject: 'Password Reset Code',
        html: `<h2>Your Reset Code: ${resetCode}</h2><p>Expires in 1 hour.</p>`
      }, (err) => {
        if (err) console.log(`❌ Email error: ${err.message}`);
        else console.log(`✅ Email sent to ${user.email}`);
      });
    }
    res.json({ message: 'Reset code sent!' });
  });
});

app.post('/api/reset-password', (req, res) => {
  const { username, reset_code, new_password } = req.body;
  if (!username || !reset_code || !new_password) return res.status(400).json({ error: 'All fields required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const stored = resetCodes.get(username);
  if (!stored || stored.code !== reset_code) return res.status(400).json({ error: 'Invalid reset code' });
  if (Date.now() > stored.expires) return res.status(400).json({ error: 'Reset code expired' });
  const new_hash = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password_hash = ? WHERE username = ?', [new_hash, username], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to reset password' });
    resetCodes.delete(username);
    res.json({ message: 'Password reset successfully!' });
  });
});

// Create default users
const createDefaultUsers = () => {
  const defaultUsers = [
    ['admin', bcrypt.hashSync('admin123', 10), 'System Admin', 'admin', 'admin@example.com'],
    ['manager', bcrypt.hashSync('manager123', 10), 'GSE Manager', 'manager', 'manager@example.com'],
    ['storekeeper', bcrypt.hashSync('keeper123', 10), 'Store Keeper', 'storekeeper', 'storekeeper@example.com']
  ];
  defaultUsers.forEach(user => {
    db.run(`INSERT OR IGNORE INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, user);
  });
};
createDefaultUsers();

app.listen(PORT, () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`✅ Login at http://localhost:3000`);
  console.log(`\n📋 Default Logins:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
});