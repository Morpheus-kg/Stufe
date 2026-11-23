// Небольшой список немецких служебных слов (нижний регистр) для оценки покрытия текста.
// Чистый ESM, без DOM и Node API.
export const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'keinen', 'keinem', 'keiner', 'und', 'oder', 'aber', 'denn', 'sondern', 'doch',
  'auch', 'nur', 'noch', 'schon', 'sehr', 'so', 'wie', 'als', 'wenn', 'dass', 'ob', 'weil', 'da',
  'damit', 'obwohl', 'während', 'bevor', 'nachdem', 'bis', 'seit', 'ich', 'du', 'er', 'sie', 'es',
  'wir', 'ihr', 'mich', 'dich', 'ihn', 'uns', 'euch', 'ihnen', 'ihm', 'mir', 'dir', 'sich',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'dein', 'deine', 'seine', 'seinen', 'seinem',
  'seiner', 'ihre', 'ihren', 'ihrem', 'ihrer', 'unser', 'unsere', 'unseren', 'euer', 'eure',
  'in', 'im', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'mit', 'nach', 'von', 'vom', 'zu', 'zum',
  'zur', 'über', 'unter', 'vor', 'hinter', 'neben', 'zwischen', 'durch', 'für', 'gegen', 'ohne',
  'um', 'ins', 'ans', 'aufs', 'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'seid', 'sein',
  'gewesen', 'habe', 'hast', 'hat', 'haben', 'habt', 'hatte', 'hatten', 'wird', 'werden', 'wurde',
  'wurden', 'worden', 'werde', 'wirst', 'kann', 'können', 'konnte', 'konnten', 'muss', 'müssen',
  'musste', 'will', 'wollen', 'wollte', 'soll', 'sollen', 'sollte', 'darf', 'dürfen', 'mag',
  'nicht', 'nichts', 'man', 'wer', 'was', 'wo', 'wann', 'warum', 'welche', 'welcher', 'welches',
  'dieser', 'diese', 'dieses', 'diesen', 'diesem', 'hier', 'dort', 'dann', 'nun', 'jetzt', 'immer',
  'oft', 'nie', 'mal', 'wieder', 'ganz', 'mehr', 'viel', 'viele', 'alle', 'allen', 'aller',
  'alles', 'einmal', 'ja', 'nein', 'also', 'etwas', 'jeder', 'jede', 'jedes', 'andere', 'anderen',
  'etwa', 'dabei', 'dazu', 'dafür', 'davon', 'darauf', 'daher', 'deshalb', 'dann', 'noch',
]);

/** @param {unknown} w */
export function isStopword(w) {
  return STOPWORDS.has(String(w ?? '').toLowerCase());
}