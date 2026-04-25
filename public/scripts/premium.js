const axiomPremium = (() => {
// Capture native fetch immediately — overriding window.fetch later won't affect this
const _fetch = window.fetch.bind(window);

```
const STORAGE_KEY = 'axiom_premium_key';
const CACHE_KEY   = 'axiom_premium_valid';
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

// 🔧 DEV MODE TEST KEY
const DEV_TEST_KEY = "1234";

function getKey() {
    return localStorage.getItem(STORAGE_KEY) || '';
}

function setKey(key) {
    localStorage.setItem(STORAGE_KEY, key);
    // Invalidate cache whenever key changes
    sessionStorage.removeItem(CACHE_KEY);
}

function clearKey() {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(CACHE_KEY);
}

async function verify(key) {
    if (!key) return false;

    // ✅ Allow local dev key to always pass
    if (key === DEV_TEST_KEY) return true;

    try {
        const res = await _fetch('/api/check-premium', {
            headers: { key }
        });
        const data = await res.json();
        return data.success === true;
    } catch {
        return false;
    }
}

// Returns true/false, caches result for CACHE_TTL ms.
async function isPremium() {
    const key = getKey();
    if (!key) return false;

    // ✅ Dev key bypasses cache + always true
    if (key === DEV_TEST_KEY) return true;

    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
        try {
            const { valid, expires } = JSON.parse(cached);
            if (Date.now() < expires) return valid;
        } catch {}
    }

    const valid = await verify(key);

    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        valid,
        expires: Date.now() + CACHE_TTL
    }));

    return valid;
}

return Object.freeze({ getKey, setKey, clearKey, verify, isPremium });
```

})();
