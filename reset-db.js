const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./gse_inventory.db');

// Create users table (if not exists)
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'storekeeper',
    email TEXT
)`);

// Delete existing users
db.run("DELETE FROM users");

// Create fresh users
const users = [
    ['admin', bcrypt.hashSync('admin123', 10), 'System Admin', 'admin', 'admin@example.com'],
    ['manager', bcrypt.hashSync('manager123', 10), 'GSE Manager', 'manager', 'manager@example.com'],
    ['storekeeper', bcrypt.hashSync('keeper123', 10), 'Store Keeper', 'storekeeper', 'storekeeper@example.com']
];

users.forEach(user => {
    db.run("INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)", user);
});

setTimeout(() => {
    console.log('✅ Users created successfully!');
    console.log('   admin / admin123');
    console.log('   manager / manager123');
    console.log('   storekeeper / keeper123');
    db.close();
}, 500);