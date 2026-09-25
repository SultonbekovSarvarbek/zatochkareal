const MAX_KNIVES = 50;
const MIN_KNIVES = 1;

// Accepts "+998 90 123-45-67", "998901234567", "(90) 123 45 67", etc.
// Returns "+998XXXXXXXXX" or null.
function normalizeUzbekPhone(phone) {
    if (typeof phone !== 'string') return null;
    const digits = phone.replace(/\D/g, '');

    if (/^998\d{9}$/.test(digits)) return '+' + digits;
    if (/^\d{9}$/.test(digits)) return '+998' + digits; // local number without country code
    return null;
}

function isValidUzbekPhone(phone) {
    return normalizeUzbekPhone(phone) !== null;
}

function isValidName(name) {
    if (typeof name !== 'string') return false;
    const length = name.trim().length;
    return length >= 2 && length <= 100;
}

function isValidLocation(location) {
    return Boolean(location) &&
        Number.isFinite(location.latitude) &&
        Number.isFinite(location.longitude) &&
        location.latitude >= -90 && location.latitude <= 90 &&
        location.longitude >= -180 && location.longitude <= 180;
}

// Returns the knives count as a number, or null if the text is not a whole number in range
function parseKnivesCount(text) {
    if (typeof text !== 'string' || !/^\d+$/.test(text.trim())) return null;
    const num = Number(text.trim());
    return num >= MIN_KNIVES && num <= MAX_KNIVES ? num : null;
}

function sanitizeLocation(location) {
    if (!isValidLocation(location)) return null;
    return { latitude: location.latitude, longitude: location.longitude };
}

module.exports = {
    MAX_KNIVES,
    MIN_KNIVES,
    normalizeUzbekPhone,
    isValidUzbekPhone,
    isValidName,
    isValidLocation,
    parseKnivesCount,
    sanitizeLocation,
};
