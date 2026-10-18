// The OpenMW engine page's own interface in the Orthros page's language (src/ports/openmw/ui-l10n.js), on a small
// stand-in of a page: whole phrases, phrases ending with a name, attributes, and nothing when the page is English.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = fs.readFileSync(new URL('../src/ports/openmw/ui-l10n.js', import.meta.url), 'utf8');
const text = (v) => ({ nodeType: 3, nodeValue: v, parentNode: null });
function el(name, attrs = {}, ...kids) {
  const e = { nodeType: 1, nodeName: name, attrs: { ...attrs }, childNodes: kids, getAttribute: (a) => e.attrs[a] ?? null, setAttribute: (a, v) => { e.attrs[a] = v; } };
  for (const k of kids) k.parentNode = e;
  return e;
}
function run(lang, body) {
  const observed = [];
  const document = { body, documentElement: {}, addEventListener() {} };
  runInNewContext(source, { document, localStorage: { getItem: () => lang }, navigator: { languages: ['en-US'] }, MutationObserver: class { constructor(fn) { observed.push(fn); } observe() {} } });
  return { document, mutate: (records) => observed[0]?.(records) };
}

test('the engine page in French: phrases, names kept, attributes, never in a script', () => {
  const tour = text('You are in the world'), next = text('Next ▸'), request = text('Friend request sent to Nerevar'), invite = text('Vivec invited you to join them.');
  const chat = el('INPUT', { placeholder: 'Type a message…', type: 'text' }), other = text('Sanglant Seyda Neen'), script = text('Close');
  const body = el('BODY', {}, el('DIV', {}, tour, next), el('P', {}, request, invite), chat, el('SPAN', {}, other), el('SCRIPT', {}, script));
  const page = run('fr', body);
  assert.equal(tour.nodeValue, 'Tu es dans le monde'); assert.equal(next.nodeValue, 'Suivant ▸');
  assert.equal(request.nodeValue, 'Demande d’ami envoyée à Nerevar'); assert.equal(invite.nodeValue, 'Vivec t’invite à le rejoindre.');
  assert.equal(chat.attrs.placeholder, 'Écris un message…');
  assert.equal(other.nodeValue, 'Sanglant Seyda Neen', 'a text it does not know: left as it is');
  assert.equal(script.nodeValue, 'Close', 'never in a script');
  assert.equal(page.document.documentElement.lang, 'fr');
  // (written later by the engine)
  const late = text('Connection lost');
  page.mutate([{ type: 'childList', addedNodes: [el('DIV', {}, late)] }]);
  assert.equal(late.nodeValue, 'Connexion perdue');
});

test('the engine page stays English for an English page', () => {
  const tour = text('You are in the world');
  run('en', el('BODY', {}, el('DIV', {}, tour)));
  assert.equal(tour.nodeValue, 'You are in the world');
});
