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

// ========== CREATE TABLES ==========
const createTables = async () => {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'storekeeper',
      email TEXT
    )`);
    
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
    
    await db.execute(`CREATE TABLE IF NOT EXISTS gse_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name TEXT NOT NULL,
      equipment_type TEXT,
      use_hour_based BOOLEAN DEFAULT 0,
      use_date_based BOOLEAN DEFAULT 0,
      last_service_date TEXT,
      last_service_hours INTEGER DEFAULT 0,
      current_hours INTEGER DEFAULT 0,
      next_service_hours INTEGER DEFAULT 0,
      next_service_date TEXT,
      service_interval_months INTEGER DEFAULT 0,
      hours_threshold INTEGER DEFAULT 0,
      service_performed TEXT,
      technician_name TEXT,
      notes TEXT,
      date_performed DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'serviced',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('✅ Tables ready');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};

// ========== ENSURE COLUMNS EXIST ==========
const ensureColumns = async () => {
  const columns = [
    'use_hour_based', 'use_date_based', 'next_service_hours', 'hours_threshold'
  ];
  for (const column of columns) {
    try {
      await db.execute(`ALTER TABLE gse_maintenance ADD COLUMN ${column} ${column === 'use_hour_based' || column === 'use_date_based' ? 'BOOLEAN DEFAULT 0' : 'INTEGER DEFAULT 0'}`);
      console.log(`✅ Added column: ${column}`);
    } catch (err) {
      // Column already exists
    }
  }
};

// ========== CREATE SAMPLE DATA ==========
const createSampleData = async () => {
  const sampleParts = [
    ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 50, 10, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
    ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 30, 8, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
    ['P003', 'Air Filter', 'Donaldson', 'Tow Tractor', 'C-03', 25, 5, 'Bob Wilson', '+1 234 567 8902', 'bob@donaldson.com'],
    ['P004', 'Hydraulic Fluid', 'Shell', 'All GSE', 'D-01', 100, 20, 'Shell Support', '+1 234 567 8903', 'support@shell.com'],
    ['P005', 'Battery', 'Exide', 'GPU', 'E-01', 15, 5, 'Exide Tech', '+1 234 567 8904', 'tech@exide.com'],
    ['P008', 'Hand Tools Set', 'Stanley', 'Hand Tools', 'H-01', 20, 5, 'Stanley Tools', '+1 234 567 8907', 'tools@stanley.com']
  ];
  
  for (const part of sampleParts) {
    const existing = await db.execute({ sql: 'SELECT id FROM parts WHERE part_number = ?', args: [part[0]] });
    if (existing.rows.length === 0) {
      await db.execute({ 
        sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock, contact_person, contact_phone, contact_email) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: part
      });
      console.log(`✅ Created sample part: ${part[0]}`);
    }
  }
  
  const today = '2026-05-27';
  const nextDate = '2026-10-27';
  const sampleEquipment = [
    ['GPU Unit #2', 'GPU', 1, 1, today, 300, 300, 600, nextDate, 6, 600],
    ['Tow Tractor #5', 'Tow Tractor', 1, 0, today, 0, 250, 250, null, 0, 250],
    ['Battery Charger #3', 'Battery Charger', 0, 1, today, null, null, null, nextDate, 6, null],
    ['Hand Tools Set #1', 'Hand Tools', 0, 0, null, null, null, null, null, 0, null]
  ];
  
  for (const eq of sampleEquipment) {
    const existing = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE equipment_name = ?', args: [eq[0]] });
    if (existing.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO gse_maintenance 
              (equipment_name, equipment_type, use_hour_based, use_date_based, 
               last_service_date, last_service_hours, current_hours, next_service_hours, 
               next_service_date, service_interval_months, hours_threshold, status, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', 'system')`,
        args: eq
      });
      console.log(`✅ Created sample GSE: ${eq[0]}`);
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
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [user.username] });
    if (existing.rows.length === 0) {
      const hashedPassword = bcrypt.hashSync(user.password, 10);
      await db.execute({ 
        sql: 'INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)', 
        args: [user.username, hashedPassword, user.full_name, user.role, user.email] 
      });
      console.log(`✅ Created user: ${user.username}`);
    }
  }
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

// ========== DUAL CONDITION CALCULATION (Manual Hour Entry) ==========
const calculateDualStatus = (item) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let status = 'serviced';
  let current_hours = item.current_hours || 0;
  let days_remaining = null;
  let hours_remaining = null;
  let next_due_display = '';
  let alert_reason = '';
  
  // Calculate hours-based status (MANUAL - comparing current vs target)
  let hourStatus = null;
  let hourRemaining = null;
  let hourTarget = null;
  
  if (item.use_hour_based && item.hours_threshold) {
    hourTarget = item.hours_threshold;
    hourRemaining = hourTarget - (item.current_hours || 0);
    
    if (hourRemaining <= 0) {
      hourStatus = 'overdue';
    } else if (hourRemaining <= 40) {
      hourStatus = 'due_soon';
    } else {
      hourStatus = 'serviced';
    }
  }
  
  // Calculate date-based status
  let dateStatus = null;
  let dateDaysRemaining = null;
  
  if (item.use_date_based && item.next_service_date) {
    const nextDate = new Date(item.next_service_date);
    dateDaysRemaining = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
    
    if (dateDaysRemaining < 0) {
      dateStatus = 'overdue';
    } else if (dateDaysRemaining <= 4) {
      dateStatus = 'due_soon';
    } else {
      dateStatus = 'serviced';
    }
  }
  
  // Determine final status - whichever is worse (overdue > due_soon > serviced)
  if (hourStatus === 'overdue' || dateStatus === 'overdue') {
    status = 'overdue';
    if (hourStatus === 'overdue') alert_reason = `Hours: ${Math.abs(hourRemaining)} hrs over target`;
    if (dateStatus === 'overdue') alert_reason = `Date: ${Math.abs(dateDaysRemaining)} days overdue`;
    if (hourStatus === 'overdue' && dateStatus === 'overdue') alert_reason = 'Both hours and date are overdue';
  } else if (hourStatus === 'due_soon' || dateStatus === 'due_soon') {
    status = 'due_soon';
    if (hourStatus === 'due_soon') alert_reason = `${hourRemaining} hours to target`;
    if (dateStatus === 'due_soon') alert_reason = `${dateDaysRemaining} days to service`;
    if (hourStatus === 'due_soon' && dateStatus === 'due_soon') alert_reason = `${hourRemaining} hrs or ${dateDaysRemaining} days`;
  }
  
  // Build next service display
  if (item.use_hour_based && item.use_date_based) {
    next_due_display = `📅 ${item.next_service_date || 'Not set'} OR ⏱️ ${item.hours_threshold || 0} hours (Current: ${item.current_hours || 0} hrs)`;
    if (hourRemaining && hourRemaining > 0) {
      next_due_display += ` | ${hourRemaining} hrs to threshold`;
    }
  } else if (item.use_hour_based) {
    next_due_display = `⏱️ Target: ${item.hours_threshold || 0} hours (Current: ${item.current_hours || 0} hrs)`;
    if (hourRemaining && hourRemaining > 0) {
      next_due_display += ` | ${hourRemaining} hrs remaining`;
    }
  } else if (item.use_date_based) {
    next_due_display = `📅 Next service: ${item.next_service_date || 'Not set'}`;
    if (dateDaysRemaining && dateDaysRemaining > 0) {
      next_due_display += ` | ${dateDaysRemaining} days remaining`;
    }
  } else {
    next_due_display = 'No maintenance scheduled';
    status = 'no_maintenance';
  }
  
  // Calculate remaining display
  let remaining_display = '';
  if (status === 'overdue') {
    remaining_display = '🔴 OVERDUE';
    if (hourRemaining && hourRemaining <= 0) remaining_display += ` (Hours: ${Math.abs(hourRemaining)} over)`;
    if (dateDaysRemaining && dateDaysRemaining < 0) remaining_display += ` (Date: ${Math.abs(dateDaysRemaining)} days late)`;
  } else if (status === 'due_soon') {
    remaining_display = '🟡 DUE SOON';
    if (hourRemaining && hourRemaining <= 40 && hourRemaining > 0) remaining_display += ` - ${hourRemaining} hours left`;
    if (dateDaysRemaining && dateDaysRemaining <= 4 && dateDaysRemaining > 0) remaining_display += ` - ${dateDaysRemaining} days left`;
  } else if (status === 'serviced') {
    remaining_display = '✅ Up to date';
    if (hourRemaining && hourRemaining > 40) remaining_display += ` (${hourRemaining} hrs to target)`;
    if (dateDaysRemaining && dateDaysRemaining > 4) remaining_display += ` (${dateDaysRemaining} days to service)`;
  }
  
  return {
    status,
    current_hours: item.current_hours || 0,
    remaining_hours: hourRemaining,
    days_remaining: dateDaysRemaining,
    next_due_display,
    remaining_display,
    alert_reason,
    hourTarget
  };
};

// ========== LOGIN ==========
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
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
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, contact_person, contact_phone, contact_email } = req.body;
  try {
    await db.execute({ 
      sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock, contact_person, contact_phone, contact_email) 
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, 
      args: [part_number, description || '', manufacturer || '', compatible_gse || '', location_bin || '', min_stock || 5, contact_person || '', contact_phone || '', contact_email || ''] 
    });
    res.json({ message: 'Part added successfully!' });
  } catch (err) {
    console.error('Create part error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== RECEIVE PARTS ==========
app.post('/api/transactions/receive', authenticateToken, async (req, res) => {
  const { part_number, quantity, reference_number, notes } = req.body;
  const receiveQty = parseInt(quantity);
  if (isNaN(receiveQty) || receiveQty <= 0) return res.status(400).json({ error: 'Invalid quantity' });
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) return res.status(404).json({ error: 'Part not found' });
    const part = partResult.rows[0];
    const newQuantity = part.quantity_on_hand + receiveQty;
    await db.execute({ sql: `INSERT INTO transactions (part_id, transaction_type, quantity, reference_number, notes, created_by, created_at) VALUES (?, 'RECEIVE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`, args: [part.id, receiveQty, reference_number || '', notes || '', req.user.username] });
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
  if (isNaN(requestQty) || requestQty <= 0) return res.status(400).json({ error: 'Invalid quantity' });
  try {
    const partResult = await db.execute({ sql: 'SELECT id, quantity_on_hand FROM parts WHERE part_number = ?', args: [part_number] });
    if (partResult.rows.length === 0) return res.status(404).json({ error: 'Part not found' });
    const part = partResult.rows[0];
    if (part.quantity_on_hand < requestQty) return res.status(400).json({ error: 'Insufficient stock available' });
    await db.execute({ sql: `INSERT INTO pending_issues (part_number, part_id, quantity, gse_registration, technician_name, work_order, notes, requested_by, requested_by_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`, args: [part_number, part.id, requestQty, gse_registration || '', technician_name || '', work_order || '', notes || '', req.user.id, req.user.username] });
    res.json({ success: true, message: 'Issue request submitted for approval' });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== GET PENDING REQUESTS ==========
app.get('/api/requests/pending', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Access denied' });
  try {
    const result = await db.execute(`SELECT p.*, parts.quantity_on_hand as current_stock, parts.description FROM pending_issues p JOIN parts ON p.part_id = parts.id WHERE p.status = 'pending' ORDER BY p.created_at DESC`);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== APPROVE REQUEST ==========
app.post('/api/requests/:id/approve', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Access denied' });
  try {
    const requestResult = await db.execute({ sql: "SELECT * FROM pending_issues WHERE id = ? AND status = 'pending'", args: [id] });
    if (requestResult.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = requestResult.rows[0];
    const requestQty = parseInt(request.quantity);
    const partResult = await db.execute({ sql: 'SELECT quantity_on_hand FROM parts WHERE id = ?', args: [request.part_id] });
    const currentStock = partResult.rows[0].quantity_on_hand;
    const newStock = currentStock - requestQty;
    if (currentStock < requestQty) return res.status(400).json({ error: `Insufficient stock! Only ${currentStock} units available.` });
    await db.execute({ sql: `INSERT INTO transactions (part_id, transaction_type, quantity, gse_registration, technician_name, work_order, notes, created_by, created_at) VALUES (?, 'ISSUE', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, args: [request.part_id, requestQty, request.gse_registration || '', request.technician_name || '', request.work_order || '', request.notes || '', req.user.username] });
    await db.execute({ sql: 'UPDATE parts SET quantity_on_hand = ? WHERE id = ?', args: [newStock, request.part_id] });
    await db.execute({ sql: "UPDATE pending_issues SET status = 'approved', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", args: [comment || null, req.user.username, id] });
    res.json({ success: true, message: 'Request approved and stock deducted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== REJECT REQUEST ==========
app.post('/api/requests/:id/reject', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({ error: 'Access denied' });
  try {
    await db.execute({ sql: "UPDATE pending_issues SET status = 'rejected', admin_comment = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", args: [comment || null, req.user.username, id] });
    res.json({ success: true, message: 'Request rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET MY REQUESTS ==========
app.get('/api/requests/my-requests', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({ sql: `SELECT p.*, parts.description FROM pending_issues p JOIN parts ON p.part_id = parts.id WHERE p.requested_by = ? ORDER BY p.created_at DESC LIMIT 50`, args: [req.user.id] });
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATE CURRENT HOURS (Manual Entry) ==========
app.put('/api/gse-maintenance/:id/hours', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { current_hours } = req.body;
  
  try {
    await db.execute({ 
      sql: 'UPDATE gse_maintenance SET current_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
      args: [current_hours, id] 
    });
    res.json({ success: true, message: 'Hours updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET GSE MAINTENANCE ==========
app.get('/api/gse-maintenance', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM gse_maintenance ORDER BY equipment_name`);
    const itemsWithStatus = result.rows.map(item => {
      const calc = calculateDualStatus(item);
      return {
        ...item,
        status: calc.status,
        current_hours: calc.current_hours,
        remaining_hours: calc.remaining_hours,
        days_remaining: calc.days_remaining,
        next_due_display: calc.next_due_display,
        remaining_display: calc.remaining_display,
        alert_reason: calc.alert_reason
      };
    });
    res.json({ success: true, equipment: itemsWithStatus });
  } catch (err) {
    console.error('Error fetching maintenance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== ADD GSE MAINTENANCE EQUIPMENT ==========
app.post('/api/gse-maintenance', authenticateToken, async (req, res) => {
  const { equipment_name, equipment_type, use_hour_based, use_date_based, service_interval_months, hours_threshold, last_service_date, last_service_hours } = req.body;
  
  try {
    if (!equipment_name) return res.status(400).json({ error: 'Equipment name is required' });
    
    let next_service_date = null;
    let next_service_hours = null;
    let current_hours = last_service_hours || 0;
    
    if (use_date_based && service_interval_months && last_service_date) {
      const date = new Date(last_service_date);
      date.setMonth(date.getMonth() + parseInt(service_interval_months));
      next_service_date = date.toISOString().split('T')[0];
    }
    
    if (use_hour_based && hours_threshold) {
      next_service_hours = parseInt(hours_threshold);
    }
    
    await db.execute({
      sql: `INSERT INTO gse_maintenance 
            (equipment_name, equipment_type, use_hour_based, use_date_based, 
             last_service_date, last_service_hours, current_hours, 
             next_service_hours, next_service_date, service_interval_months, 
             hours_threshold, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: [equipment_name, equipment_type || '', use_hour_based ? 1 : 0, use_date_based ? 1 : 0,
             last_service_date || null, last_service_hours || 0, current_hours,
             next_service_hours, next_service_date, service_interval_months || 0,
             hours_threshold || 0, req.user.username]
    });
    
    res.json({ success: true, message: 'Equipment added successfully!' });
  } catch (err) {
    console.error('Add equipment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== EDIT GSE MAINTENANCE ==========
app.put('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { equipment_name, equipment_type, use_hour_based, use_date_based, service_interval_months, hours_threshold, last_service_date, last_service_hours } = req.body;
  
  try {
    let next_service_date = null;
    let next_service_hours = null;
    let current_hours = last_service_hours || 0;
    
    if (use_date_based && service_interval_months && last_service_date) {
      const date = new Date(last_service_date);
      date.setMonth(date.getMonth() + parseInt(service_interval_months));
      next_service_date = date.toISOString().split('T')[0];
    }
    
    if (use_hour_based && hours_threshold) {
      next_service_hours = parseInt(hours_threshold);
    }
    
    await db.execute({
      sql: `UPDATE gse_maintenance 
            SET equipment_name = ?, equipment_type = ?, 
                use_hour_based = ?, use_date_based = ?,
                last_service_date = ?, last_service_hours = ?, current_hours = ?,
                next_service_hours = ?, next_service_date = ?,
                service_interval_months = ?, hours_threshold = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [equipment_name, equipment_type || '', use_hour_based ? 1 : 0, use_date_based ? 1 : 0,
              last_service_date || null, last_service_hours || 0, current_hours,
              next_service_hours, next_service_date, service_interval_months || 0,
              hours_threshold || 0, id]
    });
    
    res.json({ success: true, message: 'Equipment updated successfully!' });
  } catch (err) {
    console.error('Edit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== RECORD SERVICE ==========
app.post('/api/gse-maintenance/:id/service', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { service_performed, technician_name, notes, service_date, current_hours } = req.body;
  
  try {
    const equipmentResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE id = ?', args: [id] });
    if (equipmentResult.rows.length === 0) return res.status(404).json({ error: 'Equipment not found' });
    
    const equipment = equipmentResult.rows[0];
    let serviceDateValue = service_date || new Date().toISOString().split('T')[0];
    let currentHoursValue = current_hours !== undefined ? parseInt(current_hours) : (equipment.current_hours || 0);
    
    let next_service_date = null;
    let next_service_hours = null;
    
    if (equipment.use_date_based && equipment.service_interval_months) {
      const date = new Date(serviceDateValue);
      date.setMonth(date.getMonth() + equipment.service_interval_months);
      next_service_date = date.toISOString().split('T')[0];
    }
    
    if (equipment.use_hour_based && equipment.hours_threshold) {
      next_service_hours = equipment.hours_threshold;
    }
    
    await db.execute({
      sql: `UPDATE gse_maintenance 
            SET last_service_date = ?, last_service_hours = ?, current_hours = ?,
                next_service_date = ?, next_service_hours = ?,
                service_performed = ?, technician_name = ?, notes = ?,
                date_performed = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                status = 'serviced'
            WHERE id = ?`,
      args: [serviceDateValue, currentHoursValue, currentHoursValue, next_service_date, next_service_hours,
              service_performed || '', technician_name || '', notes || '', id]
    });
    
    let nextServiceInfo = '';
    if (equipment.use_hour_based && equipment.use_date_based) {
      nextServiceInfo = `Next service: ${next_service_date || 'N/A'} (date) OR ${next_service_hours || 0} hours (hour threshold)`;
    } else if (equipment.use_hour_based) {
      nextServiceInfo = `Next service at ${next_service_hours} hours (Current: ${currentHoursValue} hrs)`;
    } else if (equipment.use_date_based) {
      nextServiceInfo = `Next service on ${next_service_date}`;
    }
    
    res.json({ success: true, message: `✅ Service recorded!\n📅 Date: ${serviceDateValue}\n⏱️ Hours: ${currentHoursValue} hrs\n📊 ${nextServiceInfo}` });
  } catch (err) {
    console.error('Service recording error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE FROM MAINTENANCE ==========
app.delete('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  try {
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE id = ?', args: [req.params.id] });
    res.json({ success: true, message: 'Item removed from maintenance schedule' });
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
    await db.execute({ sql: 'INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)', args: [username, password_hash, full_name, role || 'storekeeper', email || null] });
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
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const result = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(current_password, result.rows[0].password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
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
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied. Admin only.' });
  if (!user_id || !new_password || new_password.length < 4) return res.status(400).json({ error: 'User ID and valid password required' });
  try {
    const userResult = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [user_id] });
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const newHashedPassword = bcrypt.hashSync(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [newHashedPassword, user_id] });
    res.json({ success: true, message: `Password reset successfully for ${userResult.rows[0].username}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FORGOT PASSWORD ==========
const resetCodes = new Map();

app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT id, username, email FROM users WHERE username = ?', args: [username] });
    if (result.rows.length === 0) return res.json({ success: true, message: 'If an account exists, a reset code has been sent.' });
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes.set(username, { code: resetCode, expires: Date.now() + 3600000 });
    console.log('========================================');
    console.log(`🔐 PASSWORD RESET CODE FOR ${username}: ${resetCode}`);
    console.log('========================================');
    res.json({ success: true, message: 'Reset code sent! Check server console.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { username, reset_code, new_password } = req.body;
  const stored = resetCodes.get(username);
  if (!stored || stored.code !== reset_code) return res.status(400).json({ error: 'Invalid reset code' });
  if (Date.now() > stored.expires) return res.status(400).json({ error: 'Reset code expired' });
  const newHashedPassword = bcrypt.hashSync(new_password, 10);
  await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE username = ?', args: [newHashedPassword, username] });
  resetCodes.delete(username);
  res.json({ success: true, message: 'Password reset successfully!' });
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

// ========== INITIALIZE ==========
const init = async () => {
  await createTables();
  await ensureColumns();
  await createUsers();
  await createSampleData();
  console.log('✅ All data initialized');
  console.log('📅 DUAL CONDITION MAINTENANCE (MANUAL HOUR ENTRY):');
  console.log('   - Hour-based: Manual hour entry, compare with target threshold');
  console.log('   - Date-based: Alert when ≤ 4 days to service date');
  console.log('   - Whichever condition comes FIRST triggers the alert');
  console.log('   - NO automatic hour calculation - all hours entered manually');
};

init();

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
  console.log(`\n🔧 Dual Condition Maintenance:`);
  console.log(`   ✅ Manual hour entry - user updates current hours daily`);
  console.log(`   ✅ System compares current hours vs target threshold`);
  console.log(`   ✅ Due Soon when ≤ 40 hours to target OR ≤ 4 days to date`);
  console.log(`   ✅ Overdue when hours exceeded OR date passed`);
});