module.exports = { readFileSync: function (f) { return /perguntas/.test(f) ? window.__PERGUNTAS__ : window.__DINAMICAS__; } };
