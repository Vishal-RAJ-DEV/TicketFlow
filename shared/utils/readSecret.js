const fs = require('node:fs');

const readSecret = (name, fallback = '') => {
  const filePath = process.env[name + '_FILE'];
  if (filePath) {
    const value = fs.readFileSync(filePath, 'utf8').replace(/\\r?\\n$/, '');
    if (value.length) return value;
  }
  const value = process.env[name];
  return value === undefined ? fallback : value;
};

module.exports = { readSecret };
