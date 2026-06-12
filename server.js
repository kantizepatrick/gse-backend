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
  'https://gse-backend.onrender.com',
  'https://cas-backend.onrender.com'
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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ========== FIX: Handle BigInt serialization ==========
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() {
    return Number(this);
  };
}

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
      maintenance_type TEXT DEFAULT 'hour',
      service_interval_hours INTEGER DEFAULT 250,
      service_interval_months INTEGER DEFAULT 6,
      service_interval_years INTEGER DEFAULT 1,
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
      FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
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
      FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS maintenance_checklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      maintenance_id INTEGER,
      checklist_item TEXT NOT NULL,
      is_checked BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (maintenance_id) REFERENCES gse_maintenance(id) ON DELETE CASCADE
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS maintenance_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      maintenance_id INTEGER,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_data TEXT,
      file_type TEXT,
      file_size INTEGER,
      uploaded_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (maintenance_id) REFERENCES gse_maintenance(id) ON DELETE CASCADE
    )`);
    
    await db.execute(`CREATE TABLE IF NOT EXISTS gse_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name TEXT NOT NULL,
      equipment_type TEXT,
      maintenance_type TEXT DEFAULT 'hour',
      part_id INTEGER,
      last_service_date TEXT,
      last_service_hours INTEGER DEFAULT 0,
      current_hours INTEGER DEFAULT 0,
      target_hours INTEGER DEFAULT 0,
      service_interval_hours INTEGER DEFAULT 250,
      service_interval_months INTEGER DEFAULT 6,
      service_interval_years INTEGER DEFAULT 1,
      last_service_year INTEGER,
      last_service_full_date TEXT,
      service_interval_months_for_hour INTEGER DEFAULT 0,
      next_service_date TEXT,
      service_performed TEXT,
      technician_name TEXT,
      notes TEXT,
      date_performed DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'serviced',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
    )`);
    
    console.log('✅ Tables ready');
  } catch (err) {
    console.error('Table error:', err.message);
  }
};

// ========== ENSURE COLUMNS EXIST ==========
const ensureColumns = async () => {
  const columns = [
    'last_service_full_date', 'service_interval_months_for_hour', 'next_service_date', 'target_hours'
  ];
  for (const column of columns) {
    try {
      await db.execute(`ALTER TABLE gse_maintenance ADD COLUMN ${column} TEXT DEFAULT NULL`);
      console.log(`✅ Added column: ${column}`);
    } catch (err) {}
  }
};

// ========== CREATE SAMPLE DATA ==========
const createSampleData = async () => {
  const sampleParts = [
    ['P001', 'Brake Pad', 'Bendix', 'Tow Tractor', 'A-01', 50, 10, 'hour', 100, null, null, 'John Smith', '+1 234 567 8900', 'john@bendix.com'],
    ['P002', 'Oil Filter', 'Fram', 'GPU', 'B-02', 30, 8, 'hour', 200, null, null, 'Jane Doe', '+1 234 567 8901', 'jane@fram.com'],
    ['P003', 'Air Filter', 'Donaldson', 'Tow Tractor', 'C-03', 25, 5, 'hour', 300, null, null, 'Bob Wilson', '+1 234 567 8902', 'bob@donaldson.com'],
    ['P004', 'Hydraulic Fluid', 'Shell', 'All GSE', 'D-01', 100, 20, 'month', null, 6, null, 'Shell Support', '+1 234 567 8903', 'support@shell.com'],
    ['P005', 'Battery', 'Exide', 'GPU', 'E-01', 15, 5, 'month', null, 12, null, 'Exide Tech', '+1 234 567 8904', 'tech@exide.com'],
    ['P006', 'Fire Extinguisher', 'Amerex', 'Safety Equipment', 'F-01', 8, 2, 'year', null, null, 1, 'Amerex Safety', '+1 234 567 8905', 'safety@amerex.com'],
    ['P007', 'Load Cell', 'Interface', 'Test Equipment', 'G-01', 5, 1, 'year', null, null, 1, 'Interface Tech', '+1 234 567 8906', 'tech@interface.com'],
    ['P008', 'Hand Tools Set', 'Stanley', 'Hand Tools', 'H-01', 20, 5, 'none', null, null, null, 'Stanley Tools', '+1 234 567 8907', 'tools@stanley.com']
  ];
  
  for (const part of sampleParts) {
    const existing = await db.execute({ sql: 'SELECT id FROM parts WHERE part_number = ?', args: [part[0]] });
    if (existing.rows.length === 0) {
      await db.execute({ 
        sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, quantity_on_hand, min_stock,
              maintenance_type, service_interval_hours, service_interval_months, service_interval_years,
              contact_person, contact_phone, contact_email) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: part
      });
      console.log(`✅ Created sample part: ${part[0]}`);
    }
  }
  
  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getFullYear();
  
  const sampleEquipment = [
    ['Tow Tractor #5', 'Tow Tractor', 'hour', 250, 0, 'Oil change', 'John Smith', today, 0, null, null],
    ['GPU Unit #2', 'GPU', 'hour', 600, 6, 'Battery check + 6 month interval', 'Jane Doe', today, 300, null, null],
    ['Battery Charger #3', 'Battery Charger', 'month', null, 6, 'Calibration', 'Bob Wilson', today, null, null, null],
    ['Fire Extinguisher #1', 'Safety Equipment', 'year', null, 1, 'Annual inspection', 'Tom Harris', null, null, currentYear - 1, `${currentYear - 1}-06-15`],
    ['Fire Extinguisher #2', 'Safety Equipment', 'year', null, 1, 'Annual inspection', 'Tom Harris', null, null, currentYear, `${currentYear}-01-15`],
    ['Hand Tools Set #1', 'Hand Tools', 'none', null, null, 'No maintenance', 'System', today, null, null, null]
  ];
  
  for (const eq of sampleEquipment) {
    const existing = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE equipment_name = ?', args: [eq[0]] });
    if (existing.rows.length === 0) {
      const nextServiceDate = eq[2] === 'hour' && eq[4] > 0 ? new Date(new Date().setMonth(new Date().getMonth() + eq[4])).toISOString().split('T')[0] : null;
      await db.execute({
        sql: `INSERT INTO gse_maintenance 
              (equipment_name, equipment_type, maintenance_type, service_interval_hours, service_interval_months_for_hour,
               service_interval_months, service_interval_years, service_performed, technician_name,
               last_service_date, last_service_hours, current_hours, target_hours,
               last_service_year, last_service_full_date, next_service_date, status, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', 'system')`,
        args: [eq[0], eq[1], eq[2], eq[3] || null, eq[4] || 0, eq[5] || null, eq[6] || null, eq[7] || '', eq[8] || '',
                eq[9] || null, eq[10] || 0, eq[10] || 0, eq[3] || null, eq[11] || null, eq[12] || null, nextServiceDate]
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

// ========== DUAL CONDITION HOUR CALCULATION ==========
const calculateDualStatus = (item) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let finalStatus = 'serviced';
  let alert_reason = '';
  let next_due_display = '';
  let current_hours = item.current_hours || 0;
  let targetHours = item.target_hours || item.service_interval_hours || 0;
  let remaining_hours = targetHours - current_hours;
  
  let hourStatus = null;
  if (targetHours > 0) {
    if (remaining_hours <= 0) {
      hourStatus = 'overdue';
    } else if (remaining_hours <= 40) {
      hourStatus = 'due_soon';
    } else {
      hourStatus = 'serviced';
    }
  }
  
  let dateStatus = null;
  let days_remaining = null;
  let nextDateStr = null;
  
  if (item.next_service_date) {
    const nextDate = new Date(item.next_service_date);
    nextDateStr = nextDate.toLocaleDateString();
    days_remaining = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
    
    if (days_remaining < 0) {
      dateStatus = 'overdue';
    } else if (days_remaining <= 4) {
      dateStatus = 'due_soon';
    } else {
      dateStatus = 'serviced';
    }
  }
  
  if (hourStatus === 'overdue' || dateStatus === 'overdue') {
    finalStatus = 'overdue';
    if (hourStatus === 'overdue') alert_reason = `Hours: ${Math.abs(remaining_hours)} hrs over target`;
    if (dateStatus === 'overdue') alert_reason = `Date: ${Math.abs(days_remaining)} days overdue`;
  } else if (hourStatus === 'due_soon' || dateStatus === 'due_soon') {
    finalStatus = 'due_soon';
    if (hourStatus === 'due_soon') alert_reason = `${remaining_hours} hours to target`;
    if (dateStatus === 'due_soon') alert_reason = `${days_remaining} days to service`;
  }
  
  if (targetHours > 0 && item.next_service_date) {
    next_due_display = `📅 ${nextDateStr} OR ⏱️ ${targetHours} hrs (Current: ${current_hours} hrs)`;
    if (remaining_hours > 0) next_due_display += ` | ${remaining_hours} hrs to target`;
    if (days_remaining > 0) next_due_display += ` | ${days_remaining} days to date`;
  } else if (targetHours > 0) {
    next_due_display = `⏱️ Target: ${targetHours} hrs (Current: ${current_hours} hrs)`;
    if (remaining_hours > 0) next_due_display += ` | ${remaining_hours} hrs remaining`;
    if (remaining_hours <= 0) next_due_display = `🔴 OVERDUE: Target was ${targetHours} hrs (Current: ${current_hours} hrs)`;
  } else if (item.next_service_date) {
    next_due_display = `📅 Next service: ${nextDateStr}`;
    if (days_remaining > 0) next_due_display += ` | ${days_remaining} days remaining`;
  }
  
  return {
    status: finalStatus,
    current_hours: current_hours,
    remaining_hours: remaining_hours > 0 ? remaining_hours : 0,
    days_remaining: days_remaining > 0 ? days_remaining : 0,
    next_due_display: next_due_display,
    alert_reason: alert_reason,
    targetHours: targetHours
  };
};

// ========== MONTH CALCULATION (uses next_service_date) ==========
const calculateMonthStatus = (item) => {
  if (!item.next_service_date) {
    return { days_remaining: 999, status: 'serviced', nextDueDate: null, daysOverdue: 0 };
  }
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nextDate = new Date(item.next_service_date);
  const daysRemaining = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
  
  let status = 'serviced';
  let daysOverdue = 0;
  if (daysRemaining < 0) {
    status = 'overdue';
    daysOverdue = Math.abs(daysRemaining);
  } else if (daysRemaining <= 4) {
    status = 'due_soon';
  }
  
  return {
    days_remaining: daysRemaining > 0 ? daysRemaining : 0,
    status,
    nextDueDate: nextDate.toLocaleDateString(),
    daysOverdue
  };
};

// ========== YEAR CALCULATION ==========
const calculateYearStatus = (lastServiceFullDate, intervalYears) => {
  if (!lastServiceFullDate) {
    return { 
      years_remaining: intervalYears, 
      status: 'serviced', 
      nextDueDate: null, 
      daysRemaining: intervalYears * 365,
      monthsRemaining: intervalYears * 12,
      nextServiceFullDate: null
    };
  }
  
  const lastDate = new Date(lastServiceFullDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextDate = new Date(lastDate);
  nextDate.setFullYear(nextDate.getFullYear() + intervalYears);
  
  const daysRemaining = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
  const monthsRemaining = (nextDate.getFullYear() - today.getFullYear()) * 12 + (nextDate.getMonth() - today.getMonth());
  const yearsRemaining = nextDate.getFullYear() - today.getFullYear();
  
  let status = 'serviced';
  
  if (daysRemaining < 0) {
    status = 'overdue';
  } else if (daysRemaining <= 30) {
    status = 'due_soon';
  } else {
    status = 'upcoming';
  }
  
  return {
    years_remaining: yearsRemaining > 0 ? yearsRemaining : 0,
    status,
    nextDueDate: nextDate.toLocaleDateString(),
    monthsRemaining: monthsRemaining > 0 ? monthsRemaining : 0,
    daysRemaining: daysRemaining > 0 ? daysRemaining : 0
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
    const cleanParts = result.rows.map(part => {
      const cleanPart = {};
      for (const [key, value] of Object.entries(part)) {
        cleanPart[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return cleanPart;
    });
    res.json(cleanParts);
  } catch (err) {
    console.error('Error fetching parts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== CREATE PART ==========
app.post('/api/parts', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, maintenance_type, service_interval_hours, service_interval_months, service_interval_years, contact_person, contact_phone, contact_email } = req.body;
  try {
    const result = await db.execute({ sql: `INSERT INTO parts (part_number, description, manufacturer, compatible_gse, location_bin, min_stock, quantity_on_hand, maintenance_type, service_interval_hours, service_interval_months, service_interval_years, contact_person, contact_phone, contact_email) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`, args: [part_number, description || '', manufacturer || '', compatible_gse || '', location_bin || '', min_stock || 5, maintenance_type || 'hour', service_interval_hours || 250, service_interval_months || 6, service_interval_years || 1, contact_person || '', contact_phone || '', contact_email || ''] });
    
    if (maintenance_type !== 'none') {
      const today = new Date().toISOString().split('T')[0];
      if (maintenance_type === 'year') {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_full_date, service_interval_years, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [part_number, manufacturer || 'GSE Part', maintenance_type || 'year', result.lastInsertRowid, today, service_interval_years || 1, req.user.username] });
      } else if (maintenance_type === 'month') {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_date, service_interval_months, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [part_number, manufacturer || 'GSE Part', maintenance_type || 'month', result.lastInsertRowid, today, service_interval_months || 6, req.user.username] });
      } else {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_date, last_service_hours, service_interval_hours, current_hours, target_hours, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [part_number, manufacturer || 'GSE Part', maintenance_type || 'hour', result.lastInsertRowid, today, service_interval_hours || 250, service_interval_hours || 250, req.user.username] });
      }
    } else {
      await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'no_maintenance', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [part_number, manufacturer || 'GSE Part', 'none', result.lastInsertRowid, req.user.username] });
    }
    res.json({ message: 'Part added successfully with maintenance record!' });
  } catch (err) {
    console.error('Create part error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATE PART ==========
app.put('/api/parts/:id', authenticateToken, async (req, res) => {
  const { part_number, description, manufacturer, compatible_gse, location_bin, min_stock, maintenance_type, service_interval_hours, service_interval_months, service_interval_years, contact_person, contact_phone, contact_email } = req.body;
  
  try {
    const partResult = await db.execute({ sql: 'SELECT * FROM parts WHERE id = ?', args: [req.params.id] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    
    const oldPart = partResult.rows[0];
    const newPartNumber = part_number || oldPart.part_number;
    const newManufacturer = manufacturer || oldPart.manufacturer;
    const newMaintType = maintenance_type || oldPart.maintenance_type;
    
    await db.execute({
      sql: `UPDATE parts SET 
            part_number = ?, description = ?, manufacturer = ?, compatible_gse = ?, 
            location_bin = ?, min_stock = ?, maintenance_type = ?, 
            service_interval_hours = ?, service_interval_months = ?, service_interval_years = ?,
            contact_person = ?, contact_phone = ?, contact_email = ?
            WHERE id = ?`,
      args: [newPartNumber, description || oldPart.description, newManufacturer, compatible_gse || oldPart.compatible_gse,
              location_bin || oldPart.location_bin, min_stock || oldPart.min_stock, newMaintType,
              service_interval_hours || oldPart.service_interval_hours, service_interval_months || oldPart.service_interval_months,
              service_interval_years || oldPart.service_interval_years, contact_person || oldPart.contact_person,
              contact_phone || oldPart.contact_phone, contact_email || oldPart.contact_email, req.params.id]
    });
    
    const existingMaint = await db.execute({ sql: 'SELECT id FROM gse_maintenance WHERE part_id = ?', args: [req.params.id] });
    const today = new Date().toISOString().split('T')[0];
    
    if (existingMaint.rows.length > 0) {
      if (newMaintType === 'none') {
        await db.execute({ sql: `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = 'none', status = 'no_maintenance', updated_at = CURRENT_TIMESTAMP WHERE part_id = ?`, args: [newPartNumber, newManufacturer || 'GSE Part', req.params.id] });
      } else if (newMaintType === 'year') {
        await db.execute({ sql: `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = 'year', service_interval_years = ?, updated_at = CURRENT_TIMESTAMP WHERE part_id = ?`, args: [newPartNumber, newManufacturer || 'GSE Part', service_interval_years || 1, req.params.id] });
      } else if (newMaintType === 'month') {
        await db.execute({ sql: `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = 'month', service_interval_months = ?, updated_at = CURRENT_TIMESTAMP WHERE part_id = ?`, args: [newPartNumber, newManufacturer || 'GSE Part', service_interval_months || 6, req.params.id] });
      } else {
        await db.execute({ sql: `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = 'hour', service_interval_hours = ?, target_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE part_id = ?`, args: [newPartNumber, newManufacturer || 'GSE Part', service_interval_hours || 250, service_interval_hours || 250, req.params.id] });
      }
    } else if (newMaintType !== 'none') {
      if (newMaintType === 'year') {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_full_date, service_interval_years, status, created_by, created_at, updated_at) VALUES (?, ?, 'year', ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [newPartNumber, newManufacturer || 'GSE Part', req.params.id, today, service_interval_years || 1, req.user.username] });
      } else if (newMaintType === 'month') {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_date, service_interval_months, status, created_by, created_at, updated_at) VALUES (?, ?, 'month', ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [newPartNumber, newManufacturer || 'GSE Part', req.params.id, today, service_interval_months || 6, req.user.username] });
      } else {
        await db.execute({ sql: `INSERT INTO gse_maintenance (equipment_name, equipment_type, maintenance_type, part_id, last_service_date, last_service_hours, service_interval_hours, current_hours, target_hours, status, created_by, created_at, updated_at) VALUES (?, ?, 'hour', ?, ?, 0, ?, 0, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, args: [newPartNumber, newManufacturer || 'GSE Part', req.params.id, today, service_interval_hours || 250, service_interval_hours || 250, req.user.username] });
      }
    }
    
    console.log(`✅ Part "${newPartNumber}" updated - Maintenance synced by ${req.user.username}`);
    res.json({ success: true, message: 'Part updated successfully with maintenance sync' });
  } catch (err) {
    console.error('Update part error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE PART ==========
app.delete('/api/parts/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager access required' });
  }
  
  try {
    const partResult = await db.execute({ sql: 'SELECT part_number FROM parts WHERE id = ?', args: [req.params.id] });
    if (partResult.rows.length === 0) {
      return res.status(404).json({ error: 'Part not found' });
    }
    const part = partResult.rows[0];
    
    await db.execute({ sql: 'DELETE FROM maintenance_attachments WHERE maintenance_id IN (SELECT id FROM gse_maintenance WHERE part_id = ?)', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM maintenance_checklist WHERE maintenance_id IN (SELECT id FROM gse_maintenance WHERE part_id = ?)', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE part_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM pending_issues WHERE part_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM transactions WHERE part_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM parts WHERE id = ?', args: [req.params.id] });
    
    console.log(`✅ Part "${part.part_number}" and all maintenance records deleted by ${req.user.username}`);
    res.json({ success: true, message: `✓ Part "${part.part_number}" and its maintenance records deleted!` });
  } catch (err) {
    console.error('Delete part error:', err.message);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// ========== GET MAINTENANCE ==========
app.get('/api/gse-maintenance', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM gse_maintenance ORDER BY equipment_name');
    
    const itemsWithStatus = result.rows.map(item => {
      const cleanItem = {};
      for (const [key, value] of Object.entries(item)) {
        cleanItem[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      
      if (cleanItem.maintenance_type === 'none') {
        return { 
          ...cleanItem, 
          status: 'no_maintenance', 
          statusText: '⚪ NO MAINTENANCE',
          statusColor: '#95a5a6',
          current_service_display: 'No maintenance required', 
          next_service_column: '⚪ No maintenance required',
          alert_reason: ''
        };
      }
      
      let status = 'serviced';
      let statusText = '✅ SERVICED';
      let statusColor = '#27ae60';
      let remaining_display = '';
      let alert_reason = '';
      
      if (cleanItem.maintenance_type === 'hour') {
        const calc = calculateDualStatus(cleanItem);
        status = calc.status;
        remaining_display = calc.next_due_display;
        alert_reason = calc.alert_reason;
        
        if (status === 'overdue') {
          statusText = '🔴 OVERDUE';
          statusColor = '#e74c3c';
        } else if (status === 'due_soon') {
          statusText = '🟡 DUE SOON';
          statusColor = '#f39c12';
        } else {
          statusText = '✅ SERVICED';
          statusColor = '#27ae60';
        }
        
        return {
          ...cleanItem,
          status,
          statusText,
          statusColor,
          remaining_display,
          alert_reason,
          current_hours: calc.current_hours,
          remaining_hours: calc.remaining_hours,
          days_remaining: calc.days_remaining,
          current_service_display: cleanItem.last_service_date ? `${cleanItem.last_service_date} (Current: ${calc.current_hours} hrs, Target: ${calc.targetHours} hrs)` : 'Not recorded',
          next_service_column: calc.next_due_display
        };
        
      } else if (cleanItem.maintenance_type === 'month') {
        const calc = calculateMonthStatus(cleanItem);
        status = calc.status;
        const interval = cleanItem.service_interval_months || '?';
        
        if (status === 'overdue') {
          statusText = '🔴 OVERDUE';
          statusColor = '#e74c3c';
          remaining_display = `Overdue by ${calc.daysOverdue} days`;
          alert_reason = `Service date passed by ${calc.daysOverdue} days`;
        } else if (status === 'due_soon') {
          statusText = '🟡 DUE SOON';
          statusColor = '#f39c12';
          remaining_display = `${calc.days_remaining} days remaining`;
          alert_reason = `${calc.days_remaining} days to service date`;
        } else {
          statusText = '✅ SERVICED';
          statusColor = '#27ae60';
          remaining_display = `${calc.days_remaining} days until service`;
          alert_reason = '';
        }
        
        return {
          ...cleanItem,
          status,
          statusText,
          statusColor,
          remaining_display,
          alert_reason,
          current_service_display: cleanItem.last_service_date || 'Not recorded',
          next_service_column: calc.nextDueDate ? `📅 ${calc.nextDueDate} (${calc.days_remaining} days remaining) - ${interval} month interval` : 'No date set'
        };
        
      } else if (cleanItem.maintenance_type === 'year') {
        const calc = calculateYearStatus(cleanItem.last_service_full_date, cleanItem.service_interval_years);
        status = calc.status;
        
        if (status === 'overdue') {
          statusText = '🔴 OVERDUE';
          statusColor = '#e74c3c';
          remaining_display = `Overdue by ${Math.abs(calc.years_remaining)} years`;
          alert_reason = `Service year passed`;
        } else if (status === 'due_soon') {
          statusText = '🟡 DUE SOON';
          statusColor = '#f39c12';
          remaining_display = `${calc.daysRemaining} days remaining`;
          alert_reason = `${calc.daysRemaining} days to service date`;
        } else {
          statusText = '✅ SERVICED';
          statusColor = '#27ae60';
          remaining_display = `${calc.daysRemaining} days until service`;
          alert_reason = '';
        }
        
        return {
          ...cleanItem,
          status,
          statusText,
          statusColor,
          remaining_display,
          alert_reason,
          current_service_display: cleanItem.last_service_full_date ? new Date(cleanItem.last_service_full_date).toLocaleDateString() : 'Not recorded',
          next_service_column: calc.nextDueDate ? `📅 ${calc.nextDueDate}` : 'No date set'
        };
      }
      
      return cleanItem;
    });
    
    res.json({ success: true, equipment: itemsWithStatus });
  } catch (err) {
    console.error('Error fetching maintenance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== ADD GSE MAINTENANCE EQUIPMENT ==========
app.post('/api/gse-maintenance', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager access required' });
  }

  const {
    equipment_name,
    equipment_type,
    maintenance_type,
    service_interval_hours,
    service_interval_months,
    service_interval_years,
    last_service_date,
    last_service_hours,
    service_performed,
    technician_name,
    notes
  } = req.body;
  
  try {
    if (!equipment_name) {
      return res.status(400).json({ error: 'Equipment name is required' });
    }
    
    let query = '';
    let args = [];
    let current_hours = last_service_hours || 0;
    let target_hours = service_interval_hours || 0;
    let next_service_date = null;
    
    if (maintenance_type === 'hour') {
      query = `INSERT INTO gse_maintenance 
               (equipment_name, equipment_type, maintenance_type, 
                service_interval_hours, target_hours, 
                last_service_date, last_service_hours, current_hours,
                service_performed, technician_name, notes, 
                status, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      args = [
        equipment_name,
        equipment_type || '',
        maintenance_type,
        service_interval_hours || 250,
        target_hours,
        last_service_date || null,
        last_service_hours || 0,
        current_hours,
        service_performed || '',
        technician_name || '',
        notes || '',
        req.user.username
      ];
    } else if (maintenance_type === 'month') {
      if (!service_interval_months) {
        return res.status(400).json({ error: 'Service interval months is required for month-based maintenance' });
      }
      if (last_service_date) {
        const date = new Date(last_service_date);
        date.setMonth(date.getMonth() + service_interval_months);
        next_service_date = date.toISOString().split('T')[0];
      }
      
      query = `INSERT INTO gse_maintenance 
               (equipment_name, equipment_type, maintenance_type, 
                service_interval_months, last_service_date, next_service_date,
                service_performed, technician_name, notes, 
                status, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      args = [
        equipment_name,
        equipment_type || '',
        maintenance_type,
        service_interval_months,
        last_service_date || null,
        next_service_date,
        service_performed || '',
        technician_name || '',
        notes || '',
        req.user.username
      ];
    } else if (maintenance_type === 'year') {
      if (last_service_date) {
        const date = new Date(last_service_date);
        date.setFullYear(date.getFullYear() + (service_interval_years || 1));
        next_service_date = date.toISOString().split('T')[0];
      }
      
      query = `INSERT INTO gse_maintenance 
               (equipment_name, equipment_type, maintenance_type, 
                service_interval_years, last_service_full_date, next_service_date,
                service_performed, technician_name, notes, 
                status, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'serviced', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      args = [
        equipment_name,
        equipment_type || '',
        maintenance_type,
        service_interval_years || 1,
        last_service_date || null,
        next_service_date,
        service_performed || '',
        technician_name || '',
        notes || '',
        req.user.username
      ];
    } else {
      query = `INSERT INTO gse_maintenance 
               (equipment_name, equipment_type, maintenance_type,
                service_performed, technician_name, notes, 
                status, created_by, created_at, updated_at)
               VALUES (?, ?, 'none', ?, ?, ?, 'no_maintenance', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      args = [
        equipment_name,
        equipment_type || '',
        service_performed || '',
        technician_name || '',
        notes || '',
        req.user.username
      ];
    }
    
    const result = await db.execute({ sql: query, args: args });
    res.json({ success: true, message: 'Equipment added successfully!', id: Number(result.lastInsertRowid) });
  } catch (err) {
    console.error('Add equipment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATE MAINTENANCE ==========
app.put('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { equipment_name, equipment_type, maintenance_type, service_interval_hours, service_interval_months, service_interval_years } = req.body;
  
  try {
    const maintResult = await db.execute({ sql: 'SELECT part_id FROM gse_maintenance WHERE id = ?', args: [id] });
    if (maintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Maintenance record not found' });
    }
    
    const partId = maintResult.rows[0].part_id;
    
    let updateQuery = '';
    let updateArgs = [];
    
    if (maintenance_type === 'hour') {
      updateQuery = `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = ?, service_interval_hours = ?, target_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      updateArgs = [equipment_name, equipment_type || '', maintenance_type, service_interval_hours || 250, service_interval_hours || 250, id];
    } else if (maintenance_type === 'month') {
      if (!service_interval_months) {
        return res.status(400).json({ error: 'Service interval months is required for month-based maintenance' });
      }
      updateQuery = `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = ?, service_interval_months = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      updateArgs = [equipment_name, equipment_type || '', maintenance_type, service_interval_months, id];
    } else if (maintenance_type === 'year') {
      updateQuery = `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = ?, service_interval_years = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      updateArgs = [equipment_name, equipment_type || '', maintenance_type, service_interval_years || 1, id];
    } else {
      updateQuery = `UPDATE gse_maintenance SET equipment_name = ?, equipment_type = ?, maintenance_type = 'none', status = 'no_maintenance', updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      updateArgs = [equipment_name, equipment_type || '', id];
    }
    
    await db.execute({ sql: updateQuery, args: updateArgs });
    
    if (partId) {
      await db.execute({ sql: `UPDATE parts SET part_number = ?, manufacturer = ?, maintenance_type = ? WHERE id = ?`, args: [equipment_name, equipment_type || '', maintenance_type || 'none', partId] });
      console.log(`✅ Part ID ${partId} synced from maintenance update`);
    }
    
    res.json({ success: true, message: 'Maintenance updated and Part synced!' });
  } catch (err) {
    console.error('Update maintenance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATE CURRENT HOURS ==========
app.put('/api/gse-maintenance/:id/hours', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { current_hours } = req.body;
  
  try {
    const equipmentResult = await db.execute({ 
      sql: 'SELECT maintenance_type, target_hours, service_interval_hours FROM gse_maintenance WHERE id = ?', 
      args: [id] 
    });
    
    if (equipmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    
    const equipment = equipmentResult.rows[0];
    
    if (equipment.maintenance_type !== 'hour') {
      return res.status(400).json({ error: 'Hours update only applicable for hour-based maintenance' });
    }
    
    const newHours = parseInt(current_hours);
    const targetHours = equipment.target_hours || equipment.service_interval_hours || 0;
    
    await db.execute({ 
      sql: 'UPDATE gse_maintenance SET current_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
      args: [newHours, id] 
    });
    
    const remainingHours = targetHours - newHours;
    let alertStatus = '';
    if (remainingHours <= 0) {
      alertStatus = 'OVERDUE';
    } else if (remainingHours <= 40) {
      alertStatus = 'DUE SOON';
    } else {
      alertStatus = 'OK';
    }
    
    res.json({ 
      success: true, 
      message: `Hours updated successfully! Current: ${newHours} hrs, Target: ${targetHours} hrs, Remaining: ${remainingHours} hrs`,
      alert: alertStatus,
      current_hours: newHours,
      remaining_hours: remainingHours
    });
  } catch (err) {
    console.error('Hours update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== RECORD SERVICE (FIXED - Updates maintenance table correctly) ==========
app.post('/api/gse-maintenance/:id/service', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    service_performed, 
    technician_name, 
    notes, 
    service_interval_hours, 
    service_interval_months, 
    service_interval_years, 
    service_date, 
    current_hours,
    target_hours,
    months_interval,
    checklist
  } = req.body;
  
  try {
    // Get current equipment data
    const equipmentResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE id = ?', args: [id] });
    if (equipmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    
    const equipment = equipmentResult.rows[0];
    const maintenanceType = equipment.maintenance_type;
    
    if (maintenanceType === 'none') {
      return res.status(400).json({ error: 'This item requires no maintenance' });
    }
    
    const serviceDateValue = service_date || new Date().toISOString().split('T')[0];
    const currentHoursValue = current_hours !== undefined ? parseInt(current_hours) : (equipment.current_hours || 0);
    const targetHoursValue = target_hours !== undefined ? parseInt(target_hours) : (equipment.target_hours || equipment.service_interval_hours || 0);
    
    let next_service_date = null;
    let updateQuery = '';
    let updateArgs = [];
    
    if (maintenanceType === 'hour') {
      const monthsIntervalValue = months_interval !== undefined ? parseInt(months_interval) : 0;
      if (monthsIntervalValue > 0) {
        const date = new Date(serviceDateValue);
        date.setMonth(date.getMonth() + monthsIntervalValue);
        next_service_date = date.toISOString().split('T')[0];
      }
      
      updateQuery = `UPDATE gse_maintenance 
                     SET service_performed = ?, 
                         technician_name = ?, 
                         notes = ?,
                         last_service_date = ?,
                         last_service_hours = ?,
                         current_hours = ?,
                         target_hours = ?,
                         service_interval_hours = ?,
                         service_interval_months_for_hour = ?,
                         next_service_date = ?,
                         date_performed = CURRENT_TIMESTAMP, 
                         updated_at = CURRENT_TIMESTAMP,
                         status = 'serviced'
                     WHERE id = ?`;
      updateArgs = [
        service_performed || 'Routine service', 
        technician_name || '', 
        notes || '', 
        serviceDateValue,
        currentHoursValue,
        currentHoursValue,
        targetHoursValue,
        targetHoursValue,
        monthsIntervalValue,
        next_service_date,
        id
      ];
      
    } else if (maintenanceType === 'month') {
      // CRITICAL FIX: Get the interval from months_interval (what user typed in frontend)
      let interval = null;
      
      // Check both possible field names from frontend
      if (months_interval !== undefined && months_interval !== null) {
        interval = parseInt(months_interval);
      } else if (service_interval_months !== undefined && service_interval_months !== null) {
        interval = parseInt(service_interval_months);
      }
      
      // Validate interval
      if (!interval || interval <= 0) {
        return res.status(400).json({ 
          error: 'Please enter the number of months until next service (e.g., 1, 2, 3, 4, 6, 12)',
          received: { months_interval, service_interval_months }
        });
      }
      
      // Calculate next service date based on the interval the user entered
      const nextDate = new Date(serviceDateValue);
      nextDate.setMonth(nextDate.getMonth() + interval);
      next_service_date = nextDate.toISOString().split('T')[0];
      
      // IMPORTANT: Update ALL relevant fields in the maintenance table
      updateQuery = `UPDATE gse_maintenance 
                     SET service_performed = ?, 
                         technician_name = ?, 
                         notes = ?,
                         last_service_date = ?,
                         service_interval_months = ?,
                         next_service_date = ?,
                         date_performed = CURRENT_TIMESTAMP, 
                         updated_at = CURRENT_TIMESTAMP,
                         status = 'serviced'
                     WHERE id = ?`;
      updateArgs = [
        service_performed || 'Routine service', 
        technician_name || '', 
        notes || '', 
        serviceDateValue,
        interval,  // This saves to service_interval_months column
        next_service_date,
        id
      ];
      
      console.log(`📝 Updating month-based maintenance: interval=${interval} months, next_service_date=${next_service_date}`);
      
    } else if (maintenanceType === 'year') {
      const newInterval = service_interval_years ? parseInt(service_interval_years) : 1;
      
      updateQuery = `UPDATE gse_maintenance 
                     SET service_performed = ?, 
                         technician_name = ?, 
                         notes = ?,
                         last_service_full_date = ?,
                         last_service_year = ?,
                         service_interval_years = ?,
                         date_performed = CURRENT_TIMESTAMP, 
                         updated_at = CURRENT_TIMESTAMP,
                         status = 'serviced'
                     WHERE id = ?`;
      updateArgs = [
        service_performed || 'Routine service', 
        technician_name || '', 
        notes || '', 
        serviceDateValue,
        new Date(serviceDateValue).getFullYear(),
        newInterval,
        id
      ];
      
    } else {
      return res.status(400).json({ error: 'Unsupported maintenance type' });
    }
    
    // Execute the update
    await db.execute({ sql: updateQuery, args: updateArgs });
    
    // Save checklist if provided
    if (checklist && checklist.length > 0) {
      await db.execute({ sql: 'DELETE FROM maintenance_checklist WHERE maintenance_id = ?', args: [id] });
      for (const item of checklist) {
        if (item && item.trim()) {
          await db.execute({ 
            sql: 'INSERT INTO maintenance_checklist (maintenance_id, checklist_item, is_checked) VALUES (?, ?, 1)', 
            args: [id, item.trim()] 
          });
        }
      }
    }
    
    // Fetch the updated record to verify
    const updatedResult = await db.execute({ sql: 'SELECT * FROM gse_maintenance WHERE id = ?', args: [id] });
    const updated = updatedResult.rows[0];
    
    let nextServiceInfo = '';
    let nextDateFormatted = '';
    
    if (maintenanceType === 'month') {
      const interval = updated.service_interval_months;
      if (updated.next_service_date) {
        nextDateFormatted = new Date(updated.next_service_date).toLocaleDateString();
        nextServiceInfo = `Next service due on ${nextDateFormatted} (${interval} month${interval !== 1 ? 's' : ''} interval)`;
      } else {
        nextServiceInfo = 'Service recorded';
      }
    } else if (maintenanceType === 'hour') {
      if (targetHoursValue > 0) {
        const nextHours = currentHoursValue + targetHoursValue;
        nextServiceInfo = `Next service when meter reaches ${nextHours} hours`;
        if (next_service_date) {
          nextServiceInfo += ` OR by date ${new Date(next_service_date).toLocaleDateString()} (whichever comes first)`;
          nextDateFormatted = new Date(next_service_date).toLocaleDateString();
        }
      } else {
        nextServiceInfo = 'Service recorded';
      }
    } else if (maintenanceType === 'year') {
      if (updated.next_service_date) {
        nextDateFormatted = new Date(updated.next_service_date).toLocaleDateString();
        nextServiceInfo = `Next service due on ${nextDateFormatted}`;
      } else {
        nextServiceInfo = 'Service recorded';
      }
    }
    
    console.log(`✅ Service recorded for ${equipment.equipment_name}:`);
    console.log(`   - service_interval_months: ${updated.service_interval_months}`);
    console.log(`   - next_service_date: ${updated.next_service_date}`);
    console.log(`   - last_service_date: ${updated.last_service_date}`);
    
    res.json({ 
      success: true, 
      message: `✅ Service recorded!\n📅 Service Date: ${serviceDateValue}\n⏱️ Current Hours: ${currentHoursValue} hrs\n🎯 Target Hours: ${targetHoursValue} hrs\n📊 ${nextServiceInfo}`,
      service_date: serviceDateValue,
      current_hours: currentHoursValue,
      target_hours: targetHoursValue,
      next_due: nextDateFormatted,
      updated_record: {
        service_interval_months: updated.service_interval_months,
        next_service_date: updated.next_service_date,
        last_service_date: updated.last_service_date
      }
    });
    
  } catch (err) {
    console.error('Service recording error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE MAINTENANCE ==========
app.delete('/api/gse-maintenance/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Admin or Manager only' });
  }
  try {
    const maintResult = await db.execute({ sql: 'SELECT part_id, equipment_name FROM gse_maintenance WHERE id = ?', args: [req.params.id] });
    if (maintResult.rows.length === 0) {
      return res.status(404).json({ error: 'Maintenance record not found' });
    }
    
    const partId = maintResult.rows[0].part_id;
    const equipmentName = maintResult.rows[0].equipment_name;
    
    await db.execute({ sql: 'DELETE FROM maintenance_attachments WHERE maintenance_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM maintenance_checklist WHERE maintenance_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM gse_maintenance WHERE id = ?', args: [req.params.id] });
    
    if (partId) {
      await db.execute({ sql: "UPDATE parts SET maintenance_type = 'none' WHERE id = ?", args: [partId] });
      console.log(`✅ Part ID ${partId} updated - maintenance_type set to 'none'`);
    }
    
    console.log(`✅ Maintenance record "${equipmentName}" deleted by ${req.user.username}`);
    res.json({ success: true, message: 'Maintenance record removed. Part maintenance_type set to "none".' });
  } catch (err) {
    console.error('Delete maintenance error:', err.message);
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

// ========== GET CHECKLIST ==========
app.get('/api/maintenance-checklist/:maintenanceId', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM maintenance_checklist WHERE maintenance_id = ? ORDER BY id', args: [req.params.maintenanceId] });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SAVE CHECKLIST ==========
app.post('/api/maintenance-checklist/:maintenanceId', authenticateToken, async (req, res) => {
  const { maintenanceId } = req.params;
  const { checklist_items } = req.body;
  
  try {
    await db.execute({ sql: 'DELETE FROM maintenance_checklist WHERE maintenance_id = ?', args: [maintenanceId] });
    for (const item of checklist_items) {
      if (item.trim()) {
        await db.execute({ sql: 'INSERT INTO maintenance_checklist (maintenance_id, checklist_item) VALUES (?, ?)', args: [maintenanceId, item.trim()] });
      }
    }
    res.json({ success: true, message: 'Checklist saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET ATTACHMENTS ==========
app.get('/api/maintenance-attachments/:maintenanceId', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({ 
      sql: 'SELECT id, filename, original_filename, file_type, file_size, uploaded_by, created_at FROM maintenance_attachments WHERE maintenance_id = ? ORDER BY created_at DESC', 
      args: [req.params.maintenanceId] 
    });
    res.json(result.rows);
  } catch (err) {
    console.error('Get attachments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPLOAD ATTACHMENT ==========
app.post('/api/maintenance-attachment/:maintenanceId', authenticateToken, async (req, res) => {
  const { maintenanceId } = req.params;
  const { filename, file_data, file_type } = req.body;
  
  if (!filename || !file_data) {
    return res.status(400).json({ error: 'No file data provided' });
  }
  
  try {
    const fileSize = Math.ceil(file_data.length * 0.75);
    await db.execute({ sql: `INSERT INTO maintenance_attachments (maintenance_id, filename, original_filename, file_data, file_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [maintenanceId, filename, filename, file_data, file_type || 'application/octet-stream', fileSize, req.user.username] });
    res.json({ success: true, message: 'File uploaded successfully', file: { filename: filename, type: file_type } });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DOWNLOAD ATTACHMENT ==========
app.get('/api/maintenance-attachment/:id/download', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT original_filename, file_data, file_type FROM maintenance_attachments WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const file = result.rows[0];
    if (!file.file_data) return res.status(404).json({ error: 'File data not found' });
    const fileBuffer = Buffer.from(file.file_data, 'base64');
    res.setHeader('Content-Type', file.file_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.original_filename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.send(fileBuffer);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== DELETE ATTACHMENT ==========
app.delete('/api/maintenance-attachment/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute({ sql: 'DELETE FROM maintenance_attachments WHERE id = ?', args: [id] });
    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== GET TRANSACTIONS ==========
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`SELECT t.*, p.part_number, p.description FROM transactions t JOIN parts p ON t.part_id = p.id ORDER BY t.created_at DESC LIMIT 50`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== LOW STOCK REPORT ==========
app.get('/api/reports/low-stock', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute(`SELECT part_number, description, quantity_on_hand, min_stock, location_bin FROM parts WHERE quantity_on_hand <= min_stock`);
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
    await db.execute({ sql: `INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)`, args: [username, password_hash, full_name, role || 'storekeeper', email || null] });
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
  console.log('📎 Base64 file attachment storage enabled');
};

init();

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GSE Server running on port ${PORT}`);
  console.log(`\n📋 Login with:`);
  console.log(`   admin / admin123 (Admin)`);
  console.log(`   manager / manager123 (Manager)`);
  console.log(`   storekeeper / keeper123 (Storekeeper)`);
  console.log(`\n📎 Attachment Storage:`);
  console.log(`   Files stored as Base64 in database`);
  console.log(`   Download via: /api/maintenance-attachment/:id/download`);
});