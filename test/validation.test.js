const test = require('node:test');
const assert = require('node:assert');
const {
    normalizeUzbekPhone,
    isValidName,
    isValidLocation,
    parseKnivesCount,
} = require('../validation');

test('normalizeUzbekPhone accepts common formats', () => {
    assert.strictEqual(normalizeUzbekPhone('+998901234567'), '+998901234567');
    assert.strictEqual(normalizeUzbekPhone('998901234567'), '+998901234567');
    assert.strictEqual(normalizeUzbekPhone('+998 (90) 123-45-67'), '+998901234567');
    assert.strictEqual(normalizeUzbekPhone('90 123 45 67'), '+998901234567');
});

test('normalizeUzbekPhone rejects invalid numbers', () => {
    assert.strictEqual(normalizeUzbekPhone('+7 999 123 45 67'), null);
    assert.strictEqual(normalizeUzbekPhone('12345'), null);
    assert.strictEqual(normalizeUzbekPhone(''), null);
    assert.strictEqual(normalizeUzbekPhone(undefined), null);
});

test('isValidName checks length', () => {
    assert.ok(isValidName('Ali'));
    assert.ok(!isValidName(' A '));
    assert.ok(!isValidName('x'.repeat(101)));
    assert.ok(!isValidName(null));
});

test('isValidLocation accepts zero coordinates and rejects garbage', () => {
    assert.ok(isValidLocation({ latitude: 0, longitude: 0 }));
    assert.ok(isValidLocation({ latitude: 41.31, longitude: 69.28 }));
    assert.ok(!isValidLocation({ latitude: 91, longitude: 0 }));
    assert.ok(!isValidLocation({ latitude: NaN, longitude: 0 }));
    assert.ok(!isValidLocation(null));
});

test('parseKnivesCount only accepts whole numbers in range', () => {
    assert.strictEqual(parseKnivesCount('5'), 5);
    assert.strictEqual(parseKnivesCount(' 50 '), 50);
    assert.strictEqual(parseKnivesCount('5abc'), null);
    assert.strictEqual(parseKnivesCount('1.5'), null);
    assert.strictEqual(parseKnivesCount('0'), null);
    assert.strictEqual(parseKnivesCount('51'), null);
});
