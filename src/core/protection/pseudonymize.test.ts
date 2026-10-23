/**
 * Pseudonymization (docs/PROTECTION-LEVELS.md, C6c).
 *
 * What must hold: German names, addresses, IBANs, phone numbers, e-mail
 * addresses, dates of birth and identifiers are replaced by placeholders; a
 * value keeps its placeholder within a session; the answer is translated
 * back exactly, a placeholder split across stream chunks included; ordinary
 * text, amounts and dates that are not birth dates are left alone.
 */
import { describe, expect, test } from 'vitest';
import { detect, Pseudonyms, StreamRestorer, validIban } from './pseudonymize';

const kinds = (text: string) => detect(text).map((s) => `${s.kind}:${s.value}`);

describe('what is detected', () => {
  test('names: a known first name and a surname, or a title and a name', () => {
    expect(kinds('Anna Müller hat angerufen.')).toEqual(['PERSON:Anna Müller']);
    expect(kinds('Termin mit Hans-Peter Schmidt-Rottluff')).toEqual(['PERSON:Hans-Peter Schmidt-Rottluff']);
    expect(kinds('Sehr geehrte Frau Dr. Özdemir,')).toEqual(['PERSON:Özdemir']);
    expect(kinds('Herrn Jürgen Weiß zur Kenntnis')).toEqual(['PERSON:Jürgen Weiß']);
    expect(kinds('Prof. Krause sagt')).toEqual(['PERSON:Krause']);
  });

  test('addresses: street and number, postcode and place', () => {
    expect(kinds('wohnhaft Lindenstraße 12a, 10115 Berlin')).toEqual(['ADDRESS:Lindenstraße 12a', 'PLACE:10115 Berlin']);
    expect(kinds('Hauptstr. 5 in 80331 München')).toEqual(['ADDRESS:Hauptstr. 5', 'PLACE:80331 München']);
    expect(kinds('Am Markt 3')).toEqual(['ADDRESS:Am Markt 3']);
    expect(kinds('Bad Homburger Weg 7')).toEqual(['ADDRESS:Bad Homburger Weg 7']);
  });

  test('IBANs that pass the check, with or without spaces', () => {
    expect(validIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(validIban('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(kinds('IBAN: DE89 3704 0044 0532 0130 00')).toEqual(['IBAN:DE89 3704 0044 0532 0130 00']);
    expect(kinds('IBAN DE89370400440532013000.')).toEqual(['IBAN:DE89370400440532013000']);
    expect(kinds('Ref DE89 3704 0044 0532 0130 01').filter((k) => k.startsWith('IBAN'))).toEqual([]);
  });

  test('phone numbers and e-mail addresses', () => {
    expect(kinds('Tel. +49 30 1234567')).toEqual(['PHONE:+49 30 1234567']);
    expect(kinds('Rückruf unter 0171 2345678')).toEqual(['PHONE:0171 2345678']);
    expect(kinds('Fax 030/12345-67')).toEqual(['PHONE:030/12345-67']);
    expect(kinds('an praxis.mueller@example.de schreiben')).toEqual(['EMAIL:praxis.mueller@example.de']);
  });

  test('dates of birth and identifiers behind their labels', () => {
    expect(kinds('geb. 03.04.1981')).toEqual(['DATE:03.04.1981']);
    expect(kinds('Geburtsdatum: 3.4.81')).toEqual(['DATE:3.4.81']);
    expect(kinds('Kundennummer: 4711-23')).toEqual(['ID:4711-23']);
    expect(kinds('Vers.-Nr. A123456789')).toEqual(['ID:A123456789']);
    expect(kinds('Patienten-ID 88231')).toEqual(['ID:88231']);
    expect(kinds('Az. 3 O 123/24')).toEqual(['ID:3 O 123/24']);
    expect(kinds('Kundennummer: 4711-23 bitte prüfen')).toEqual(['ID:4711-23']);
  });

  test('ordinary text, amounts and other dates stay', () => {
    expect(kinds('Die Rechnung über 1.250,00 Euro ist am 15.03.2026 fällig.')).toEqual([]);
    expect(kinds('Wir liefern 12345 Stück bis Montag.')).toEqual([]);
    expect(kinds('Der Koch kommt am Dienstag um 10 Uhr.')).toEqual([]);
    expect(kinds('Anna Am Montag')).toEqual([]);
  });
});

describe('what the review found (C6c)', () => {
  test('an identifier is cut before the word after it, so it is replaced', () => {
    expect(kinds('Kundennummer 4711 Am Montag')).toEqual(['ID:4711']);
    expect(kinds('Versichertennummer A123456789 Bitte prüfen')).toEqual(['ID:A123456789']);
    expect(kinds('Az. 3 O 123/24 Das Gericht')).toEqual(['ID:3 O 123/24']);
    expect(new Pseudonyms().pseudonymize('Kundennummer 4711 Am Montag')).toBe('Kundennummer [ID_1] Am Montag');
  });

  test('hyphenated streets, double first names and names outside ASCII', () => {
    expect(kinds('Sophie-Scholl-Straße 4')).toEqual(['ADDRESS:Sophie-Scholl-Straße 4']);
    expect(kinds('Konrad-Adenauer-Str. 5')).toEqual(['ADDRESS:Konrad-Adenauer-Str. 5']);
    expect(kinds('Anna Lena Müller kommt')).toEqual(['PERSON:Anna Lena Müller']);
    expect(kinds('Hans Peter Schmidt kommt')).toEqual(['PERSON:Hans Peter Schmidt']);
    expect(kinds('Herr René Dupont')).toEqual(['PERSON:René Dupont']);
    expect(kinds('Herr Dvořák')).toEqual(['PERSON:Dvořák']);
    expect(kinds('Frau Gómez')).toEqual(['PERSON:Gómez']);
    expect(kinds('Anna Özdemir')).toEqual(['PERSON:Anna Özdemir']);
    expect(kinds('an anna.müller@firma.de')).toEqual(['EMAIL:anna.müller@firma.de']);
  });

  test('a surname alone is its own placeholder and comes back as written', () => {
    const p = new Pseudonyms();
    const out = p.pseudonymize('Thomas Koch und Lisa Winter. Der Koch empfiehlt im Winter Suppe.');
    expect(p.restore(out)).toBe('Thomas Koch und Lisa Winter. Der Koch empfiehlt im Winter Suppe.');
    const q = new Pseudonyms();
    q.pseudonymize('Martin Luther, Lukas Martin');
    expect(q.restore(q.pseudonymize('Martin kommt'))).toBe('Martin kommt');
  });

  test('dates, phrases and big numbers are not addresses, places or phone numbers', () => {
    expect(kinds('Im Januar 2025 und Am Freitag 15 Uhr, Zum Glück 3 mal')).toEqual([]);
    expect(kinds('25000 Besucher, 12000 Franken')).toEqual([]);
    expect(kinds('1 000 000 000 Euro')).toEqual([]);
  });

  test('a long run of capitalised words stays fast', () => {
    const text = 'Alpha Beta Gamma Delta '.repeat(5_000);
    const start = Date.now();
    detect(text);
    expect(Date.now() - start).toBeLessThan(1_500);
  });
});

describe('the mapping', () => {
  test('replaces, keeps a placeholder per value, and restores exactly', () => {
    const p = new Pseudonyms();
    const text = 'Frau Anna Müller (geb. 03.04.1981), Lindenstraße 12a, 10115 Berlin, IBAN DE89 3704 0044 0532 0130 00, anna@example.de';
    const out = p.pseudonymize(text);
    expect(out).toBe('Frau [PERSON_1] (geb. [DATE_1]), [ADDRESS_1], [PLACE_1], IBAN [IBAN_1], [EMAIL_1]');
    expect(p.restore(out)).toBe(text);
    // The same person later in the conversation; the surname alone has its own placeholder.
    expect(p.pseudonymize('Hat Anna Müller bezahlt? Frau Müller fragt nach.')).toBe('Hat [PERSON_1] bezahlt? Frau [PERSON_2] fragt nach.');
    expect(p.restore('Frau [PERSON_2]')).toBe('Frau Müller');
    // Another person gets the next numbers.
    expect(p.pseudonymize('Herr Thomas Becker')).toBe('Herr [PERSON_3]');
  });

  test('an answer and tool arguments are translated back; unknown placeholders stay', () => {
    const p = new Pseudonyms();
    p.pseudonymize('Kunde Jonas Wagner, Tel. 0171 2345678');
    expect(p.restore('Ich rufe [PERSON_1] unter [PHONE_1] an. [PERSON_9]')).toBe('Ich rufe Jonas Wagner unter 0171 2345678 an. [PERSON_9]');
    expect(p.restoreDeep({ to: '[PHONE_1]', note: ['für [PERSON_1]'], n: 3 })).toEqual({ to: '0171 2345678', note: ['für Jonas Wagner'], n: 3 });
  });

  test('a placeholder split across stream chunks is restored whole', () => {
    const p = new Pseudonyms();
    p.pseudonymize('Herr Lukas Schulz');
    const r = new StreamRestorer(p);
    const out = [r.push('Guten Tag [PER'), r.push('SON_1], wie'), r.push(' geht es? [1] und ['), r.flush()].join('');
    expect(out).toBe('Guten Tag Lukas Schulz, wie geht es? [1] und [');
  });

  test('text without personal data is left as it is', () => {
    const p = new Pseudonyms();
    const text = 'Bitte die offenen Angebote der Woche zusammenfassen.';
    expect(p.pseudonymize(text)).toBe(text);
    expect(p.size).toBe(0);
  });
});
