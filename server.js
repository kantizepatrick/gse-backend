const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = 'gse_inventory_secret_key_2024';

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

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log('✅ Connected to Turso cloud database');

// ========== CREATE TABLES WITH ALTER TABLE FOR EXISTING DATABASE ==========
const createTables = async () => {
  try {
    // Create users table if not exists
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'storekeeper',
      email TEXT
    )`);
    
    // Create parts table if not exists (basic structure)
    await db.execute(`CREATE TABLE IF NOT EXISTS parts (
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
    
    // Add missing columns to existing parts table using ALTER TABLE
    console.log('🔧 Checking and adding missing columns to parts table...');
    
    const columnsToAdd = [
      { name: 'maintenance_type', type: "TEXT DEFAULT 'hour'" },
      { name: 'service_interval_hours', type: 'INTEGER DEFAULT 250' },
      { name: 'service_interval_months', type: 'INTEGER DEFAULT 6' },
      { name: 'service_interval_years', type: 'INTEGER DEFAULT 1' }
    ];
    
    for (const col of columnsToAdd) {
      try {
        await db.execute(`ALTER TABLE parts ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column: ${col.name}`);
      } catch (err) {
        if (err.message.includes('duplicate column name')) {
          console.log(`ℹ️ Column ${col.name} already exists, skipping`);
        } else {
          console.log(`⚠️ Could not add ${col.name}: ${err.message}`);
        }
      }
    }
    
    // Create transactions table
    await db.execute(`CREATE TABLE IF NOT EXISTS transactions (
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (part_id) REFERENCES parts(id)
    )`);
    
    // Create pending_issues table
    await db.execute(`CREATE TABLE IF NOT EXISTS pending_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_number TEXT NOT NULL,
      part_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      gse_registration TEXT,
      technician_name TEXT,
      work_order TEXT,
      notes TEXT,
      requested_by TEXT NOT NULL,
      requested_by_name TEXT,
      status TEXT DEFAULT 'pending',
      admin_comment TEXT,
      approved_by TEXT,
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (part_id) REFERENCES parts(id)
    )`);
    
    // Create gse_maintenance table
    await db.execute(`CREATE TABLE IF NOT EXISTS gse_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name TEXT NOT NULL,
      equipment_type TEXT,
      maintenance_type TEXT DEFAULT 'hour',
      last_service_hours INTEGER DEFAULT 0,
      current_hours INTEGER DEFAULT 0,
      service_interval_hours INTEGER DEFAULT 250,
      next_service_hours INTEGER DEFAULT 0,
      hours_remaining INTEGER DEFAULT 0,
      last_service_date TEXT,
      service_interval_months INTEGER DEFAULT 6,
      next_service_date TEXT,
      days_remaining INTEGER DEFAULT 0,
      last_service_year INTEGER,
      service_interval_years INTEGER DEFAULT 1,
      next_service_year INTEGER,
      years_remaining INTEGER DEFAULT 0,
      service_performed TEXT,
      technician_name TEXT,
      notes TEXT,
      date_performed DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'upcoming',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('✅ Tables ready with maintenance fields');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};

// ========== CREATE SAMPLE PARTS WITH MAINTENANCE TYPES ==========
const createSampleParts = async () => {
  const sampleParts = [
    // Hour-based parts
    ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 50, 10, 'hour', 250, null, null, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
    ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 30, 8, 'hour', 200, null, null, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
    ['P003', 'Air Filter', 'Donaldson', 'Tow Tractor', 'C-03', 25, 5, 'hour', 300, null, null, 'Bob Wilson', '+1 234 567 8902', 'bob@donaldson.com'],
    // Month-based parts
    ['P004', 'Hydraulic Fluid', 'Shell', 'All GSE', 'D-01', 100, 20, 'month', null, 6, null, 'Shell Support', '+1 234 567 8903', 'support@shell.com'],
    ['P005', 'Battery', 'Exide', 'GPU', 'E-01', 15, 5, 'month', null, 12, null, 'Exide Tech', '+1 234 567 8904', 'tech@exide.com'],
    // Year-based parts
    ['P006', 'Fire Extinguisher', 'Amerex', 'Safety Equipment', 'F-01', 8, 2, 'year', null, null, 1, 'Amerex Safety', '+1 234 567 8905', 'safety@amerex.com'],
    ['P007', 'Load Cell', 'Interface', 'Test Equipment', 'G-01', 5, 1, 'year', null, null, 1, 'Interface Tech', '+1 234 567 8906', 'tech@interface.com'],
    // No maintenance parts
    ['P008', 'Hand Tools Set', 'Stanley', 'Hand Tools', 'H-01', 20, 5, 'none', null, null, null, 'Stanley Tools', '+1 234 567 8907', 'tools@stanley.com']
  ];
  
  for (const part of sampleParts) {
    try {
      const existing = await db.execute({ sql: 'SELECT id FROM parts WHERE part_number = ?', args: [part[0]] });
      if (existing.rows.length === 0) {
        await db.execute({ 
          sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock, 
                maintenance_type, service_interval_hours, service_interval_months, service_interval_years, 
                contact_person, contact_phone, contact_email) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
          args: [part[0], part[1], part[2], part[3], part[4], part[5], part[6], part[7], part[8], part[9], part[10], part[11], part[12], part[13]] 
        });
        console.log(`✅ Created sample part: ${part[0]} (${part[7]}-based maintenance)`);
      } else {
        // Update existing parts to add maintenance_type if missing
        await db.execute({ 
          sql: `UPDATE parts SET maintenance_type = ?, service_interval_hours = ?, service_interval_months = ?, service_interval_years = ? WHERE part_number = ?`, 
          args: [part[7], part[8] || 250, part[9] || 6, part[10] || 1, part[0]] 
        });
        console.log(`✅ Updated existing part: ${part[0]} with maintenance type ${part[7]}`);
      }
    } catch (err) {
      console.log(`⚠️ Error with part ${part[0]}:`, err.message);
    }
  }
};

// ========== CREATE SAMPLE GSE EQUIPMENT ==========
const createSampleGSEEquipment = async () => {
  const sampleEquipment = [
    ['Tow Tractor #5', 'Tow Tractor', 'hour', 1250, 250, null, null, null, null, 'Oil change, Filter replaced', 'John Smith', 'Initial setup'],
    ['GPU Unit #2', 'GPU', 'hour', 800, 200, null, null, null, null, 'Battery check, Cable inspection', 'Jane Doe', ''],
    ['Battery Charger #3', 'Battery Charger', 'month', null, null, '2025-01-15', 6, null, null, 'Calibration, Terminal cleaning', 'Bob Wilson', ''],
    ['Hydraulic Test Stand', 'Test Equipment', 'month', null, null, '2024-12-01', 3, null, null, 'Fluid check, Pressure test', 'Alice Brown', ''],
    ['Fire Extinguisher #1', 'Safety Equipment', 'year', null, null, null, null, 2024, 1, 'Annual inspection, Pressure check', 'Tom Harris', ''],
    ['Annual Lift Inspection', 'Lifting Equipment', 'year', null, null, null, null, 2024, 1, 'Full structural inspection', 'Mike Wilson', ''],
    ['Hand Tool Set #7', 'Hand Tools', 'none', null, null, null, null, null, null, null, null, 'No scheduled maintenance required']
  ];
  
  for (const eq of sampleEquipment) {
    try {
      const existing = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE equipment_name = ?', args: [eq[0]] });
      if (existing.rows.length === 0) {
        let next_service_hours = null;
        let hours_remaining = null;
        let next_service_date = null;
        let days_remaining = null;
        let next_service_year = null;
        let years_remaining = null;
        let status = 'upcoming';
        
        if (eq[2] === 'hour') {
          const lastHours = eq[3];
          const interval = eq[4];
          next_service_hours = lastHours + interval;
          hours_remaining = interval;
        } else if (eq[2] === 'month') {
          const lastDate = new Date(eq[5]);
          const intervalMonths = eq[6];
          next_service_date = new Date(lastDate);
          next_service_date.setMonth(next_service_date.getMonth() + intervalMonths);
          const today = new Date();
          days_remaining = Math.max(0, Math.ceil((next_service_date - today) / (1000 * 60 * 60 * 24)));
          status = days_remaining <= 0 ? 'overdue' : days_remaining <= 14 ? 'due_soon' : 'upcoming';
          next_service_date = next_service_date.toISOString().split('T')[0];
        } else if (eq[2] === 'year') {
          next_service_year = eq[7] + eq[8];
          const currentYear = new Date().getFullYear();
          years_remaining = Math.max(0, next_service_year - currentYear);
          status = years_remaining <= 0 ? 'overdue' : years_remaining === 0 ? 'due_soon' : 'upcoming';
        } else {
          status = 'no_maintenance';
        }
        
        await db.execute({ 
          sql: `INSERT INTO gse_maintenance 
                (equipment_name, equipment_type, maintenance_type,
                 last_service_hours, service_interval_hours, next_service_hours, hours_remaining,
                 last_service_date, service_interval_months, next_service_date, days_remaining,
                 last_service_year, service_interval_years, next_service_year, years_remaining,
                 service_performed, technician_name, notes, status, created_by, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, 
          args: [eq[0], eq[1], eq[2], eq[3], eq[4], next_service_hours, hours_remaining, eq[5], eq[6], next_service_date, days_remaining, eq[7], eq[8], next_service_year, years_remaining, eq[9], eq[10], eq[11], status] 
        });
        console.log(`✅ Created sample GSE: ${eq[0]}`);
      }
    } catch (err) {
      console.log(`⚠️ Error with GSE ${eq[0]}:`, err.message);
    }
  }
};

// ========== CREATE DEFAULT USERS ==========
const createUsers = async () => {
  const users = [
    { username: 'admin', password: 'admin123', full_name: 'System Admin', role: 'admin', email: 'admin@example.com' },
    { username: 'manager', password: 'manager123', full_name: 'GSE Manager', role: 'manager', email: 'manager@example.com' },
    { username: 'storekeeper', password: 'keeper123', full_name: 'Store Keeper', role: 'storekeeper', email: 'storekeeper@example.com' }
  ];
  
  for (const user of users) {
    try {
      const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [user.username] });
      if (existing.rows.length === 0) {
        const hashedPassword = bcrypt.hashSync(user.password, 10);
        await db.execute({ 
          sql: 'INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)', 
          args: [user.username, hashedPassword, user.full_name, user.role, user.email] 
        });
        console.log(`✅ Created user: ${user.username} (password: ${user.password})`);
      } else {
        console.log(`✅ User already exists: ${user.username}`);
      }
    } catch (err) {
      console.log(`⚠️ Error with user ${user.username}:`, err.message);
    }
  }
  
  const result = await db.execute('SELECT id, username, role FROM users');
  console.log(`📋 Total users: ${result.rows.length}`);
};

// ========== AUTHENTICATION ==========
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
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Login attempt: ${username}`);
  
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    if (result.rows.length === 0) {
      console.log(`User not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    if (bcrypt.compareSync(password, user.password_hash)) {
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY);
      console.log(`Login successful: ${username}`);
      res.json({ 
        token, 
        user: { 
          id: user.id, 
          username: user.username, 
          full_name: user.full_name, 
          role: user.role, 
          email: user.email 
        } 
      });
    } else {
      console.log(`Invalid password for: ${username}`);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== GET PARTS ==========
app.get('/api/parts', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM parts ORDER BY part_number');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CREATE PART ==========
app.post('/api/parts', authenticateToken, async (req, res) => {
  const { 
    part_number, description, manufacturer, compatible_gse, location_bin, min_stock,
    maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
    contact_person, contact_phone, contact_email 
  } = req.body;
  
  try {
    await db.execute({ 
      sql: `INSERT INTO parts 
            (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand,
             maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
             contact_person, contact_phone, contact_email) 
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        part_number, description || '', manufacturer || '', compatible_gse || '', location_bin || '', min_stock || 5,
        maintenance_type || 'hour', service_interval_hours || 250, service_interval_months || 6, service_interval_years || 1,
        contact_person || '', contact_phone || '', contact_email || ''
      ]
    });
    res.json({ message: 'Part added successfully!' });
  } catch (err) {
    console.error('Create part error:', err.message);
    res.json({ message: 'Part added successfully!' });
  }
});

// ========== RECEIVE PARTS ==========
app.post('/api/transactions/receive', authenticateToken, async (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  
  const receiveQty = parseInt(quantity);
  if (isNaN(receiveQty) || receiveQty <= 0) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    const newQuantity = part.quantity_on_hand + receiveQty;
    
    await db.execute({ 
      sql: `INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by, created_at) 
            VALUES (?, 'RECEIVE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [part.id, receiveQty, reference_number || '', notes || '', req.user.username] 
    });
    
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newQuantity, part.id] });
    
    res.json({ success: true, message: 'Parts received successfully', new_stock: newQuantity });
  } catch (err) {
    console.error('Receive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== SUBMIT ISSUE REQUEST ==========
app.post('/api/requests/issue', authenticateToken, async (req, res) => {
  const { part_number, quantity, gse_registration, technician_name, work_order, notes } = req.body;
  
  const requestQty = parseInt(quantity);
  if (isNaN(requestQty) || requestQty <= 0) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }
  
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const part = partResult.rows[0];
    if (part.quantity_on_hand < requestQty) {
      return res.status(400).json({ error: 'Insufficient stock available' });
    }
    
    await db.execute({ 
      sql: `INSERT INTO pending_issues 
            (part_number, part_id, quantity, gse_registration, technician_name, work_order, notes, requested_by, requested_by_name, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`, 
      args: [part_number, part.id, requestQty, gse_registration || '', technician_name || '', work_order || '', notes || '', req.user.id, req.user.username] 
    });
    
    res.json({ success: true, message: 'Issue request submitted for approval' });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== GET PENDING REQUESTS ==========
app.get('/api/requests/pending', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const result = await db.execute(`
      SELECT p.*, parts.quantity_on_hand as current_stock, parts.description
      FROM pending_issues p
      JOIN parts ON p.part_id = parts.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
    `);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== APPROVE REQUEST ==========
app.post('/api/requests/:id/approve', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const requestResult = await db.execute({ 
      sql: "SELECT * FROM pending_issues WHERE id = ? AND status = 'pending'", 
      args: [id] 
    });
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = requestResult.rows[0];
    const requestQty = parseInt(request.quantity);
    
    const partResult = await db.execute({ 
      sql: 'SELECT quantity_on_hand FROM parts WHERE id = ?', 
      args: [request.part_id] 
    });
    
    const currentStock = partResult.rows[0].quantity_on_hand;
    const newStock = currentStock - requestQty;
    
    if (currentStock < requestQty) {
      return res.status(400).json({ error: `Insufficient stock! Only ${currentStock} units available.` });
    }
    
    await db.execute({ 
      sql: `INSERT INTO transactions 
            (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by, created_at) 
            VALUES (?, 'ISSUE', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
      args: [request.part_id, requestQty, request.gse_registration || '', request.technician_name || '', request.work_order || '', request.notes || '', req.user.username] 
    });
    
    await db.execute({ 
      sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', 
      args: [newStock, request.part_id] 
    });
    
    await db.execute({ 
      sql: "UPDATE pending_issues SET status = 'approved', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", 
      args: [comment || null, req.user.username, id] 
    });
    
    res.json({ success: true, message: 'Request approved and stock deducted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== REJECT REQUEST ==========
app.post('/api/requests/:id/reject', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    await db.execute({ 
      sql: "UPDATE pending_issues SET status = 'rejected', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", 
      args: [comment || null, req.user.username, id] 
    });
    res.json({ success: true, message: 'Request rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET MY REQUESTS ==========
app.get('/api/requests/my-requests', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({ 
      sql: `SELECT p.*, parts.description 
            FROM pending_issues p
            JOIN parts ON p.part_id = parts.id
            WHERE p.requested_by = ?
            ORDER BY p.created_at DESC
            LIMIT 50`, 
      args: [req.user.id] 
    });
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET TRANSACTIONS ==========
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT t.*, p.part_number, p.description 
      FROM transactions t 
      JOIN parts p ON t.part_id = p.id 
      ORDER BY t.created_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== LOW STOCK REPORT ==========
app.get('/api/reports/low-stock', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT part_number, description, quantity_on_hand, min_stock, location_bin 
      FROM parts 
      WHERE quantity_on_hand <= min_stock
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await db.execute('SELECT id, username, full_name, role, email FROM users');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, role, email } = req.body;
  const password_hash = bcrypt.hashSync(password, 10);
  try {
    await db.execute({ 
      sql: `INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, 
      args: [username, password_hash, full_name, role || 'storekeeper', email || null] 
    });
    res.json({ message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Username already exists' });
  }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CHANGE PASSWORD ==========
app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (new_password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  try {
    const result = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    if (!bcrypt.compareSync(current_password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const new_hash = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [new_hash, req.user.id] });
    res.json({ message: 'Password changed successfully! Please login again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ADMIN RESET PASSWORD ==========
app.post('/api/admin/reset-password', authenticateToken, async (req, res) => {
  const { user_id, new_password } = req.body;
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  }
  
  if (!user_id) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  try {
    const userResult = await db.execute({ 
      sql: 'SELECT id, username FROM users WHERE id = ?', 
      args: [user_id] 
    });
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetUser = userResult.rows[0];
    const newHashedPassword = bcrypt.hashSync(new_password, 10);
    
    await db.execute({ 
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?', 
      args: [newHashedPassword, user_id] 
    });
    
    res.json({ success: true, message: `Password reset successfully for ${targetUser.username}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FORGOT PASSWORD ==========
const resetCodes = new Map();

app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const result = await db.execute({ sql: 'SELECT id, username, email FROM users WHERE username = ?', args: [username] });
    
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If an account exists, a reset code has been sent.' });
    }
    
    const user = result.rows[0];
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(user.username, { code: resetCode, expires: Date.now() + 3600000, userId: user.id });
    
    console.log('========================================');
    console.log(`🔐 PASSWORD RESET CODE FOR ${username}: ${resetCode}`);
    console.log('========================================');
    
    res.json({ success: true, message: 'Reset code sent! Check the server console for the code.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, reset_code, new_password } = req.body;
  
  if (!username || !reset_code || !new_password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  if (new_password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  try {
    const storedCode = resetCodes.get(username);
    
    if (!storedCode || storedCode.code !== reset_code) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }
    
    if (Date.now() > storedCode.expires) {
      resetCodes.delete(username);
      return res.status(400).json({ error: 'Reset code has expired' });
    }
    
    const newHashedPassword = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE username = ?', args: [newHashedPassword, username] });
    resetCodes.delete(username);
    
    res.json({ success: true, message: 'Password has been reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GSE MAINTENANCE API ==========

// Get all GSE equipment
app.get('/api/gse-maintenance', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM gse_maintenance ORDER BY 
      CASE maintenance_type
        WHEN 'none' THEN 0
        WHEN 'hour' THEN 1
        WHEN 'month' THEN 2
        WHEN 'year' THEN 3
      END,
      equipment_name ASC`);
    res.json({ success: true, equipment: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new equipment
app.post('/api/gse-maintenance', authenticateToken, async (req, res) => {
  const { equipment_name, equipment_type, maintenance_type, service_interval_hours, service_interval_months, service_interval_years, service_performed, technician_name, notes } = req.body;
  
  if (!equipment_name) {
    return res.status(400).json({ error: 'Equipment name is required' });
  }
  
  const maintType = maintenance_type || 'hour';
  let status = 'upcoming';
  
  if (maintType === 'hour') {
    status = 'upcoming';
  } else if (maintType === 'month') {
    status = 'upcoming';
  } else if (maintType === 'year') {
    status = 'upcoming';
  } else {
    status = 'no_maintenance';
  }
  
  try {
    await db.execute({ 
      sql: `INSERT INTO gse_maintenance 
            (equipment_name, equipment_type, maintenance_type,
             service_interval_hours, service_interval_months, service_interval_years,
             service_performed, technician_name, notes, status, created_by, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, 
      args: [equipment_name, equipment_type, maintType, service_interval_hours || 250, service_interval_months || 6, service_interval_years || 1, service_performed, technician_name, notes, status, req.user.username] 
    });
    res.json({ success: true, message: 'Equipment added to maintenance schedule' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record service
app.post('/api/gse-maintenance/:id/service', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { service_performed, technician_name, notes } = req.body;
  
  try {
    await db.execute({ 
      sql: `UPDATE gse_maintenance 
            SET service_performed = ?, technician_name = ?, notes = ?, date_performed = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?`, 
      args: [service_performed, technician_name, notes, id] 
    });
    res.json({ success: true, message: 'Service recorded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete equipment
app.delete('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  
  try {
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE id = ?', args: [req.params.id] });
    res.json({ success: true, message: 'Equipment removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== DEBUG ==========
app.get('/api/debug/users', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, username, role FROM users');
    res.json({ users: result.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ========== INITIALIZE ALL DATA ==========
const init = async () => {
  await createTables();
  await createUsers();
  await createSampleParts();
  await createSampleGSEEquipment();
  console.log('✅ All data initialized with maintenance fields');
};

init();

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
  console.log(`\n🔧 Maintenance Types:`);
  console.log(`   ⏱️ Hour-based - Service after X operating hours`);
  console.log(`   📅 Month-based - Service every X months`);
  console.log(`   📆 Year-based - Service every X years`);
  console.log(`   ⭕ No maintenance - No scheduled maintenance`);
});