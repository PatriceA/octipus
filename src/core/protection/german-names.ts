/**
 * Common first names in Germany (German and frequent international ones),
 * lower-cased. A capitalised word after one of them is taken as a surname
 * by the pseudonymizer (pseudonymize.ts). Not complete, and not meant to be:
 * titles (Herr, Frau, Dr.) catch the rest.
 */
export const GERMAN_FIRST_NAMES: ReadonlySet<string> = new Set(`
adam adrian agnes alexander alexandra alfred ali alice alina alma amelie andrea andreas angelika anja anke anna annette anton antonia
armin arne astrid axel barbara beate ben benedikt benjamin bernd bernhard bettina bianca birgit björn brigitte burkhard carina carla
carl carolin caroline charlotte christa christian christiane christina christine christoph christopher claudia clemens cornelia daniel
daniela david denise dennis detlef diana dieter dirk dominik doris dorothea edith elena elias elif elisabeth ella elke ellen emil emilia
emily emma erik erika ernst esther eva fabian felix finn florian frank franz franziska frederik frieda friedrich fritz gabriele georg
gerda gerhard gisela greta gregor gudrun guido günter günther hanna hannah hannelore hans harald heike heinz helene helga helmut hendrik
henning henry herbert hermann hilde holger horst hugo ida ilse ina inge ingeborg ingo ingrid irene iris isabel isabella jakob jan jana
janina jannik jasmin jens jessica joachim jochen johann johanna johannes jonas jonathan josef julia julian juliane jürgen justus karin
karl karla karolina katharina kathrin katja katrin kerstin kevin kim klara klaus konrad kristina lara larissa lars laura lea lena leni
leo leon leonie liam lina linda lisa lotta louis louisa luca lucas lukas luisa luise lutz maja manfred manuel manuela marc marcel
marco margarete maria marie marina mario marion marius mark markus marlene martha martin martina mathias matthias max maximilian maya
melanie mia michael michaela milan mila mira mohammed monika moritz nadine natalie nicole niklas nico nicolas nils nina noah nora
norbert olaf olga oliver otto patricia patrick paul paula peter petra philipp pia rainer ralf ralph regina reinhard renate rene robert
roland rolf rosemarie ruth sabine sabrina sandra sara sarah sascha sebastian silke simon simone sofia sophia sophie stefan stefanie
steffen stephan susanne svenja sven sylvia tanja theo thomas thorsten tim timo tobias tom torsten ulla ulrich ulrike ursula ute uwe
valentin vanessa vera verena viktor viktoria walter werner wilhelm wolfgang yvonne zoe
`.trim().split(/\s+/));
