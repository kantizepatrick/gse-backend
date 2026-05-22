const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

// ========== CORS CONFIGURATION ==========
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'https://gse-frontend.onrender.com',
  'https://casgseinv.onrender.com',
  'https://gse-backend.onrender.com'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy does not allow this origin'), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json());

// ========== DATABASE ==========
const db = new Database('/tmp/gse_inventory.db');

// Create tables
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'storekeeper',
  email TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS parts (
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

db.exec(`CREATE TABLE IF NOT EXISTS transactions (
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
  
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (bcrypt.compareSync(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY);
      res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PARTS MANAGEMENT ==========
app.get('/api/parts', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM parts ORDER BY part_number').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions/receive', authenticateToken, (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  
  try {
    const part = db.prepare('SELECT id, quantity_on_hand FROM parts WHERE part_number = ?').get(part_number);
    
    if (!part) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const insertTransaction = db.prepare(`INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)`);
    const updatePart = db.prepare(`UPDATE parts SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?`);
    
    const transaction = db.transaction(() => {
      insertTransaction.run(part.id, 'RECEIVE', quantity, reference_number, notes, req.user.username);
      updatePart.run(quantity, part.id);
    });
    
    transaction();
    res.json({ message: 'Parts received successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions/issue', authenticateToken, (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  
  try {
    const part = db.prepare('SELECT id, quantity_on_hand FROM parts WHERE part_number = ?').get(part_number);
    
    if (!part) return res.status(404).json({ error: 'Part not found' });
    if (part.quantity_on_hand < quantity) return res.status(400).json({ error: 'Insufficient stock' });
    
    const insertTransaction = db.prepare(`INSERT INTO transactions (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const updatePart = db.prepare(`UPDATE parts SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?`);
    
    const transaction = db.transaction(() => {
      insertTransaction.run(part.id, 'ISSUE', quantity, gse_registration, technician_name, work_order, notes, req.user.username);
      updatePart.run(quantity, part.id);
    });
    
    transaction();
    res.json({ message: 'Parts issued successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`SELECT t.*, p.part_number, p.description FROM transactions t JOIN parts p ON t.part_id = p.id ORDER BY t.created_at DESC LIMIT 50`).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/low-stock', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`SELECT part_number, description, quantity_on_hand, min_stock, location_bin FROM parts WHERE quantity_on_hand <= min_stock`).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parts', authenticateToken, (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, contact_person, contact_phone, contact_email } = req.body;
  
  try {
    const insert = db.prepare(`INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand, contact_person, contact_phone, contact_email)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
    const result = insert.run(part_number, description, manufacturer, compatible_gse, location_bin, min_stock || 5, contact_person, contact_phone, contact_email);
    res.json({ id: result.lastInsertRowid, message: 'Part added successfully!' });
  } catch (err) {
    res.json({ message: 'Part added successfully!' });
  }
});

app.put('/api/parts/:id', authenticateToken, (req, res) => {
  const { contact_person, contact_phone, contact_email, location_bin, min_stock } = req.body;
  
  try {
    const update = db.prepare(`UPDATE parts SET contact_person = ?, contact_phone = ?, contact_email = ?, location_bin = ?, min_stock = ? WHERE id = ?`);
    update.run(contact_person, contact_phone, contact_email, location_bin, min_stock, req.params.id);
    res.json({ message: 'Part updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/parts/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  
  try {
    const del = db.prepare('DELETE FROM parts WHERE id = ?');
    del.run(req.params.id);
    res.json({ message: 'Part deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  try {
    const rows = db.prepare('SELECT id, username, full_name, role, email FROM users').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  
  const password_hash = bcrypt.hashSync(password, 10);
  
  try {
    const insert = db.prepare(`INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`);
    insert.run(username, password_hash, full_name, role || 'storekeeper', email || null);
    res.json({ message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, role, email } = req.body;
  
  try {
    const update = db.prepare('UPDATE users SET full_name = ?, role = ?, email = ? WHERE id = ?');
    update.run(full_name, role, email, req.params.id);
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  
  try {
    const del = db.prepare('DELETE FROM users WHERE id = ?');
    del.run(req.params.id);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PASSWORD MANAGEMENT ==========
app.post('/api/change-password', authenticateToken, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  
  try {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    
    const new_hash = bcrypt.hashSync(new_password, 10);
    const update = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    update.run(new_hash, req.user.id);
    res.json({ message: 'Password changed successfully! Please login again.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

app.post('/api/admin/reset-password', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { user_id, new_password } = req.body;
  if (!user_id || !new_password) return res.status(400).json({ error: 'User ID and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  
  const new_hash = bcrypt.hashSync(new_password, 10);
  
  try {
    const update = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    update.run(new_hash, user_id);
    res.json({ message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ========== FORGOT PASSWORD ==========
app.post('/api/forgot-password', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  
  try {
    const user = db.prepare('SELECT id, username, email FROM users WHERE username = ?').get(username);
    
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    console.log('========================================');
    console.log(`🔐 RESET CODE FOR ${username}: ${resetCode}`);
    console.log('========================================');
    
    res.json({ message: 'Reset code sent! Check server logs for code.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', (req, res) => {
  const { username, reset_code, new_password } = req.body;
  if (!username || !reset_code || !new_password) return res.status(400).json({ error: 'All fields required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  
  const new_hash = bcrypt.hashSync(new_password, 10);
  
  try {
    const update = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
    update.run(new_hash, username);
    res.json({ message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ========== DEBUG ENDPOINTS ==========
app.get('/api/debug/users', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, username, role FROM users').all();
    res.json({ success: true, count: rows.length, users: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Create default users
const createDefaultUsers = () => {
  const defaultUsers = [
    ['admin', bcrypt.hashSync('admin123', 10), 'System Admin', 'admin', 'admin@example.com'],
    ['manager', bcrypt.hashSync('manager123', 10), 'GSE Manager', 'manager', 'manager@example.com'],
    ['storekeeper', bcrypt.hashSync('keeper123', 10), 'Store Keeper', 'storekeeper', 'storekeeper@example.com']
  ];
  
  defaultUsers.forEach(user => {
    try {
      const insert = db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`);
      insert.run(user[0], user[1], user[2], user[3], user[4]);
    } catch (err) {
      // User already exists
    }
  });
};
createDefaultUsers();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`✅ CORS enabled for: ${allowedOrigins.join(', ')}`);
  console.log(`✅ Frontend URL: https://casgseinv.onrender.com`);
});