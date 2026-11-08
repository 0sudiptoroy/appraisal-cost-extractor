import {templateItems} from './template-items.mjs';

const columns = ['Materials', 'Labor', 'Equipment', 'Total'];
const amountColumns = ['C', 'D', 'E', 'F'];
const templateTotalRow = templateItems.length + 2;
const key = text => text.normalize('NFKC').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const poolSpaIds = new Set(['poolspa', 'poolandspa']);
const sectionNames = new Map([
  ['directcostitems', 'direct'],
  ['indirectcostitems', 'indirect'],
  ['grandtotal', 'grand'],
]);
const subtotalNames = new Map([
  ['subtotaldirectjobcost', 'direct'],
  ['subtotalindirectjobcost', 'indirect'],
]);
const templateStyleRows = new Map(templateItems.map((label, index) => [key(label), index + 2]));

export class ReportError extends Error {}

function textLines(items) {
  const spans = items.flatMap(item => {
    const text = item.str?.trim();
    if (!text) return [];
    const [a, b, , , x, y] = item.transform;
    if (a <= 0 || Math.abs(b) > 1) return [];
    return [{text, x, y, right: x + item.width}];
  }).sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const span of spans) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - span.y) <= 2) {
      line.spans.push(span);
    } else {
      lines.push({y: span.y, spans: [span]});
    }
  }
  return lines.map(line => {
    line.spans.sort((a, b) => a.x - b.x);
    return {...line, id: key(line.spans.map(span => span.text).join(' '))};
  });
}

function findLayout(line, pageWidth) {
  const headings = columns.map(name => line.spans.find(span => key(span.text) === key(name)));
  if (headings.some(span => !span)) return null;
  const edges = headings.map(span => span.right);
  if (edges.some((edge, i) => i > 0 && edge - edges[i - 1] < 25)) return null;
  return {
    left: line.spans[0].x,
    amountStart: edges[0] - (edges[1] - edges[0]) * 0.79,
    edges,
    pageWidth,
  };
}

function splitLine(line, layout) {
  const label = [];
  const amounts = columns.map(() => []);
  for (const span of line.spans) {
    if (span.x < layout.amountStart) {
      label.push(span.text);
      continue;
    }
    const index = layout.edges.findIndex(edge => span.x < edge + 7);
    if (index !== -1) amounts[index].push(span.text);
  }
  return {
    label: label.join(' '),
    amounts: amounts.map(parts => parts.join('')),
    aligned: Math.abs(line.spans[0].x - layout.left) <= 7,
  };
}

function toCents(text) {
  const value = text.replace(/[$\s]/g, '').replace(/−/g, '-');
  if (!value || /^[-–—]+$/.test(value)) return null;
  const signed = value.replace(/^\((.+)\)$/, '-$1');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(signed)) return NaN;
  const cents = Math.round(Number(signed.replace(/,/g, '')) * 100);
  return Math.abs(cents) <= 1e12 ? cents : NaN;
}

function readRows(pages) {
  const rows = [];
  let layout = null;
  let section = null;

  for (const {items, width, page} of pages) {
    if (layout && Math.abs(layout.pageWidth - width) > 3) layout = null;
    const lines = textLines(items);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (sectionNames.has(line.id)) {
        section = sectionNames.get(line.id);
        continue;
      }
      if (line.id === 'itemnamematerialslaborequipmenttotal') {
        layout = findLayout(line, width);
        continue;
      }
      if (!layout || !section) continue;

      const {label, amounts, aligned} = splitLine(line, layout);
      const isPoolSpa = poolSpaIds.has(key(label));
      if (!aligned || !label || (!isPoolSpa && !amounts.some(Boolean))) continue;

      // A cost name can wrap underneath the first line while its amounts
      // stay on the first line. The continuation sits closer than a new row.
      const next = lines[i + 1];
      let fullLabel = label;
      if (next && !isPoolSpa && line.y - next.y <= 11.5 && !sectionNames.has(next.id)) {
        const tail = splitLine(next, layout);
        if (tail.aligned && tail.label && !poolSpaIds.has(key(tail.label)) && tail.amounts.every(value => !value)) {
          fullLabel += ' ' + tail.label;
          i++;
        }
      }
      const id = key(fullLabel);
      rows.push({id, label: fullLabel, page, section, amounts: amounts.map(toCents)});
      if (id === 'totalcost' && section === 'grand') return rows;
    }
  }
  return rows;
}

function totalsFor(entries) {
  const sums = [0, 0, 0];
  for (const {amounts} of entries) {
    for (let i = 0; i < 3; i++) sums[i] += amounts[i] ?? 0;
  }
  return [...sums, sums.reduce((a, b) => a + b, 0)];
}

export function parseCostReport(pages) {
  const rows = readRows(pages);
  if (!rows.some(row => row.id !== 'totalcost' && !subtotalNames.has(row.id))) {
    throw new ReportError('Could not find the replacement-cost table. Choose a text-based appraisal PDF with the same cost table as your sample.');
  }

  const issues = [];
  const warnings = [];
  const entries = [];
  const subtotals = new Map();
  let sourceTotal = null;
  let rowDifferences = 0;

  for (const row of rows) {
    const subtotal = subtotalNames.get(row.id);
    const isPoolSpa = poolSpaIds.has(row.id);
    if (row.amounts.some(Number.isNaN) || (row.amounts[3] == null && !isPoolSpa)) {
      issues.push('Could not read all amounts for “' + row.label + '” on page ' + row.page + '.');
      continue;
    }
    if (row.id === 'totalcost') {
      if (row.section === 'grand') sourceTotal = row;
      else issues.push('Check the location of “' + row.label + '” on page ' + row.page + '.');
      continue;
    }
    if (subtotal) {
      if (subtotals.has(subtotal) || row.section !== subtotal) {
        issues.push('Check the location of “' + row.label + '” on page ' + row.page + '.');
      } else {
        subtotals.set(subtotal, row);
      }
      continue;
    }
    const components = row.amounts.slice(0, 3);
    const calculated = components.reduce((sum, value) => sum + (value ?? 0), 0);
    // Some reports list Pool/Spa without a printed total. Its inputs still
    // participate in the subtotal and grand-total checks below.
    const difference = Math.abs(calculated - (row.amounts[3] ?? calculated));
    if (difference > (components.filter(value => value != null).length + 1) * 50) {
      issues.push('The amounts for “' + row.label + '” do not add up to its PDF total on page ' + row.page + '.');
    } else if (difference) {
      rowDifferences++;
    }
    entries.push({...row, calculated});
  }

  const totals = totalsFor(entries);
  let summaryDifferences = 0;

  function checkTotals(summary, selected) {
    const calculated = totalsFor(selected);
    const differingColumns = columns.filter((name, i) => {
      const source = summary.amounts[i] ?? 0;
      const difference = Math.abs(calculated[i] - source);
      if (!difference) return false;
      summaryDifferences++;
      const values = selected.flatMap(row => i === 3 ? row.amounts.slice(0, 3) : [row.amounts[i]]);
      const numeric = values.filter(value => value != null);
      const maxRounding = (numeric.length + 1) * 50;
      if (difference > maxRounding) {
        issues.push(name + ' for “' + summary.label + '” does not reconcile with the extracted rows.');
        return false;
      }
      return true;
    });
    if (differingColumns.length) {
      warnings.push('The Excel formulas give slightly different ' + differingColumns.join(', ').toLowerCase()
        + ' amounts for “' + summary.label + '.” Review the PDF for rounding.');
    }
  }

  for (const [section, subtotal] of subtotals) {
    checkTotals(subtotal, entries.filter(row => row.section === section));
  }
  if (sourceTotal) checkTotals(sourceTotal, entries);
  else issues.push('Could not verify the Grand Total → Total cost row in the PDF.');

  if (rowDifferences) warnings.push(rowDifferences + ' item totals differ slightly from the sum of their displayed PDF amounts.');

  return {
    entries, totals, sourceTotal, issues, warnings,
    cleanTotals: !issues.length && !rowDifferences && !summaryDifferences,
  };
}

function formulaXml(formula, cents) {
  return '<f>' + formula + '</f><v>' + (cents / 100) + '</v>';
}

function costRowXml(entry, row, templateRow) {
  // Store report labels as Excel text, including labels with XML punctuation.
  const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;'};
  const name = entry.label
    .replace(/_x[0-9a-f]{4}_/gi, value => '_x005F_' + value.slice(1))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '\ufffd')
    .replace(/[&<>]/g, char => entities[char]);
  const styles = Object.fromEntries(Array.from(templateRow.matchAll(/<c r="([A-F])\d+" s="(\d+)"/g),
    ([, column, style]) => [column, style]));
  const cell = (column, fallback = 6) => '<c r="' + column + row + '" s="' + (styles[column] ?? fallback) + '"';
  const inputs = amountColumns.slice(0, 3).map((column, index) => {
    const cents = entry.amounts[index];
    return cell(column) + (cents == null ? '/>' : '><v>' + (cents / 100) + '</v></c>');
  }).join('');
  const total = formulaXml('SUM(C' + row + ':E' + row + ')', entry.calculated);
  return '<row r="' + row + '" spans="1:6" x14ac:dyDescent="0.2">'
    + cell('A', 9) + ' t="inlineStr"><is><t xml:space="preserve">' + name + '</t></is></c>'
    + cell('B', 7) + '/>' + inputs + cell('F') + '>' + total + '</c></row>';
}

export async function fillWorkbook(zipLibrary, templateBytes, report) {
  if (report.issues.length || !report.sourceTotal || !report.entries.length) {
    throw new Error('The report has unresolved extraction issues.');
  }
  const {entries, totals} = report;
  const totalRow = entries.length + 2;
  const zip = await zipLibrary.loadAsync(templateBytes);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const workbookPath = 'xl/workbook.xml';
  const chainPath = 'xl/calcChain.xml';
  const stringsPath = 'xl/sharedStrings.xml';
  const [sheet, workbook, chain, strings] = await Promise.all(
    [sheetPath, workbookPath, chainPath, stringsPath].map(path => zip.file(path).async('string')),
  );

  // Rebuild the sheet body in source order and reuse the template for styling.
  const templateRows = new Map(Array.from(sheet.matchAll(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g),
    ([xml, row]) => [Number(row), xml]));
  const header = templateRows.get(1);
  const templateFooter = templateRows.get(templateTotalRow);
  if (!header || !templateFooter) throw new Error('The Excel template is missing its header or total row.');

  const costs = entries.map((entry, index) => {
    const styleRow = templateRows.get(templateStyleRows.get(entry.id)) ?? '';
    return costRowXml(entry, index + 2, styleRow);
  }).join('');
  const footer = templateFooter
    .replace('r="' + templateTotalRow + '"', 'r="' + totalRow + '"')
    .replace(/r="([A-F])\d+"/g, (_, column) => 'r="' + column + totalRow + '"')
    .replace(/(<c r="([C-F])\d+"[^>]*>)[\s\S]*?<\/c>/g, (_, cell, column) => {
      const formula = 'SUM(' + column + '2:' + column + (totalRow - 1) + ')';
      return cell + formulaXml(formula, totals[amountColumns.indexOf(column)]) + '</c>';
    });

  zip.file(sheetPath, sheet
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, () => '<sheetData>' + header + costs + footer + '</sheetData>')
    .replace('ref="A1:F' + templateTotalRow + '"', 'ref="A1:F' + totalRow + '"')
    .replace('ref="A1:G' + templateTotalRow + '"', 'ref="A1:G' + totalRow + '"'));
  zip.file(workbookPath, workbook.replace('$A$1:$G$' + templateTotalRow, () => '$A$1:$G$' + totalRow));
  const formulaAddresses = [
    ...entries.map((_, index) => 'F' + (index + 2)),
    ...amountColumns.map(column => column + totalRow),
  ];
  const chainCells = formulaAddresses.map(address => '<c r="' + address + '" i="1"/>').join('');
  zip.file(chainPath, chain.replace(/(<calcChain\b[^>]*>)[\s\S]*?(<\/calcChain>)/,
    (_, open, close) => open + chainCells + close));
  zip.file(stringsPath, strings.replace(/(<sst\b[^>]*?) count="\d+"/, '$1'));
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
