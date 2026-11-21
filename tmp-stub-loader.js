// Sisipkan tmp-stub-register.js ke require.cache sebagai ./register.js
const path = require('path');
const real = require.resolve(path.join(__dirname, 'register.js'));
const stub = require(path.join(__dirname, 'tmp-stub-register.js'));
require.cache[real] = { id: real, filename: real, loaded: true, exports: stub, children: [], paths: [] };
