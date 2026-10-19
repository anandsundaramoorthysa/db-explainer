import { SchemaModel } from '../types';
import { lintSql, NullCounts } from './lint';

/** The answer with its code blocks removed, so only the explanation in words is judged. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Problems in an answer that can be known without seeing any data: mistakes the schema reveals in the SQL, and parts of
 * the question the answer left out. Used to ask the model once to correct itself. Returns plain sentences.
 *
 * @param pasted problems already found in a query the developer pasted for review (the corrected query must not keep them)
 */
export function answerProblems(model: SchemaModel, question: string, text: string, sql: string[], pasted: string[] = [], nullCounts?: NullCounts): string[] {
  const q = question.toLowerCase();
  const out: string[] = [];
  const words = prose(text);

  for (const s of sql) for (const w of lintSql(model, s, nullCounts)) out.push(`In your query: ${w}`);

  if (/\bnot\s+in\b/.test(q) && /\bnot\s+exists\b/.test(q) && /\b(compare|both|vs|versus|difference)\b/.test(q)) {
    const all = sql.join('\n');
    if (!/\bnot\s+in\b/i.test(all) || !/\bnot\s+exists\b/i.test(all)) out.push('You were asked to give both queries. Give a NOT IN query and a NOT EXISTS query, each in its own ```sql block.');
    if (words.length < 120 || !/null/i.test(words)) out.push('Explain in words how the two differ and which one is correct for this data. Say what happens when the subquery column contains a NULL.');
  }

  if (/revenue|sales|total|sum|amount|spend|spent|earn|average|\bavg\b/.test(q) && sql.length) {
    if (!/\bround\s*\(/i.test(sql.join('\n'))) out.push('Wrap every money total or average in ROUND(expression, 2).');
    if (!/status|cancel|pending|complet|includ/i.test(words)) out.push('Say in words which statuses or rows the total counts (a plain total includes cancelled and pending rows, and a view may already filter them).');
  }

  if (pasted.length) {
    if (!sql.length) out.push('Finish with ONE complete corrected query in a single ```sql block.');
    else if (lintSql(model, sql[sql.length - 1], nullCounts).length) out.push('The final corrected query must fix every problem found in the original, not only some of them.');
  }

  return [...new Set(out)];
}

/** The follow-up asked of the model when its answer has problems. */
export function repairRequest(problems: string[]): string {
  const fence = '`'.repeat(3);
  return `Your answer has problems that can be checked against the schema:\n${problems.map((p) => '- ' + p).join('\n')}\n\nAnswer the original question again in full, fixing all of them. Explain in words, and give the complete corrected SQL in ${fence}sql blocks. Do not mention this message.`;
}
