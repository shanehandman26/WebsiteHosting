(function (root) {
    const key = 'ocean-rush-username';
    let current = '';
    function clean(value) {
        return typeof value === 'string' ? value.replace(/[^A-Za-z0-9 _-]/g, '').replace(/ +/g, ' ').trim().slice(0, 16) : '';
    }
    function load() {
        for (const store of ['localStorage', 'sessionStorage']) {
            try { const value = clean(root[store]?.getItem(key)); if (value) return value; } catch { /* Storage can be blocked. */ }
        }
        return current;
    }
    function save(value) {
        current = clean(value);
        for (const store of ['localStorage', 'sessionStorage']) {
            try { root[store]?.setItem(key, current); } catch { /* Keep the in-page selection usable. */ }
        }
        return current;
    }
    const profile = { clean, load, save };
    if (typeof module !== 'undefined' && module.exports) module.exports = profile;
    else root.OceanProfile = profile;
})(typeof window !== 'undefined' ? window : globalThis);
