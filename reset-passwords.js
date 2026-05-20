const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./gse_inventory.db');

const newAdminHash = bcrypt.hashSync('admin123', 10);
const newManagerHash = bcrypt.hashSync('manager123', 10);
const newStorekeeperHash = bcrypt.hashSync('keeper123', 10);

db.run("UPDATE users SET password_hash = ? WHERE username = 'admin'", [newAdminHash]);
db.run("UPDATE users SET password_hash = ? WHERE username = 'manager'", [newManagerHash]);
db.run("UPDATE users SET password_hash = ? WHERE username = 'storekeeper'", [newStorekeeperHash]);

setTimeout(() => {
    console.log('✅ Passwords reset successfully!');
    console.log('   admin / admin123');
    console.log('   manager / manager123');
    console.log('   storekeeper / keeper123');
    db.close();
}, 500);