import {parseCostReport, fillWorkbook, ReportError} from './converter.mjs?v=pdf-order';

const byId = id => document.getElementById(id);
const input = byId('pdf-input');
const zone = byId('drop-zone');
const results = byId('results');
const download = byId('download');
const replace = byId('replace-file');
const uploadStatus = byId('upload-status');
const downloadStatus = byId('download-status');
const progress = byId('read-progress');
const number = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2,
});

let reading = false;
let workbookUrl = null;

function showMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = !message;
}

function displayAmounts(row, values) {
  for (const cents of values) {
    const cell = row.insertCell();
    cell.textContent = cents == null ? '—' : number.format(cents / 100);
  }
}

function rowHeader(row, label) {
  const cell = document.createElement('th');
  cell.scope = 'row';
  cell.textContent = label;
  row.append(cell);
}

function renderResult(report) {
  const {entries, totals, sourceTotal, issues, warnings, cleanTotals} = report;
  const state = byId('result-state');
  state.textContent = issues.length ? 'Download unavailable' : warnings.length ? 'Review details' : 'Ready to download';
  state.classList.toggle('review', Boolean(issues.length || warnings.length));
  byId('results-subtitle').textContent = issues.length
    ? 'Check the items below before using these amounts.'
    : cleanTotals ? 'Items follow the PDF order. The extracted costs reconcile to the PDF totals.'
      : 'Items follow the PDF order. Compare the PDF and Excel totals below.';
  byId('row-count').textContent = String(entries.length);
  byId('report-total').textContent = sourceTotal ? usd.format(sourceTotal.amounts[3] / 100) : '—';
  byId('excel-total').textContent = usd.format(totals[3] / 100);

  const notes = byId('notes');
  const messages = [...issues, ...warnings];
  notes.replaceChildren();
  notes.hidden = !messages.length;
  if (messages.length) {
    const title = document.createElement('p');
    title.textContent = issues.length ? 'Items to resolve' : 'Items to review';
    const list = document.createElement('ul');
    for (const message of messages) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    notes.append(title, list);
  }

  const body = byId('cost-rows');
  body.replaceChildren();
  for (const {label, amounts, calculated, page} of entries) {
    const row = body.insertRow();
    rowHeader(row, label);
    displayAmounts(row, [...amounts.slice(0, 3), calculated]);
    row.insertCell().textContent = String(page);
  }
  const foot = byId('cost-foot');
  foot.replaceChildren();
  const row = foot.insertRow();
  rowHeader(row, 'Total cost');
  displayAmounts(row, totals);
  row.insertCell();

  results.hidden = false;
}

async function prepareDownload(file, report) {
  try {
    const response = await fetch(new URL('./cost-template.xlsx', import.meta.url));
    if (!response.ok) throw new Error('Excel template unavailable.');
    const workbook = await fillWorkbook(globalThis.JSZip, await response.arrayBuffer(), report);
    const blob = new Blob([workbook], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    workbookUrl = URL.createObjectURL(blob);
    const name = file.name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 140).trim();
    download.href = workbookUrl;
    download.download = (name || 'Appraisal') + ' - Cost Estimate.xlsx';
    download.hidden = false;
  } catch {
    showMessage(downloadStatus, 'Could not prepare the Excel file. Replace the PDF to try again.', true);
  }
}

async function readPdf(file) {
  let pdfjs;
  try {
    pdfjs = await import('./assets/pdf.min.mjs');
  } catch (error) {
    throw new ReportError('The site could not load the PDF reader. Publish the assets folder and refresh the site.', {cause: error});
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./assets/pdf.worker.min.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useWasm: false,
    standardFontDataUrl: new URL('./assets/standard_fonts/', import.meta.url).href,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw new ReportError('Choose a report with 100 pages or fewer.');
    progress.max = pdf.numPages;
    progress.value = 0;
    const pages = [];
    let hasText = false;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const {items} = await page.getTextContent();
      hasText ||= items.some(item => item.str?.trim());
      pages.push({page: pageNo, items, width: page.view[2] - page.view[0]});
      progress.value = pageNo;
      page.cleanup();
    }
    if (!hasText) throw new ReportError('This PDF has no selectable text. Run OCR on the scan and upload the searchable PDF.');
    return {report: parseCostReport(pages), pages: pdf.numPages};
  } finally {
    await task.destroy();
  }
}

function pdfError(error) {
  if (error instanceof ReportError) return error.message;
  if (error.name === 'PasswordException') return 'This PDF is password-protected. Upload an unlocked copy.';
  if (error.name === 'InvalidPDFException') return 'This file could not be read as a PDF. Export a fresh copy and try again.';
  if (error.message?.includes('Setting up fake worker failed')) {
    return 'The PDF reader worker could not load. Check that assets/pdf.worker.min.mjs is published and refresh.';
  }
  return 'The PDF could not be processed. Try opening the site again and selecting a text-based report.';
}

async function selectFiles(files) {
  if (reading || !files.length) return;
  if (files.length !== 1) {
    showMessage(uploadStatus, 'Choose one PDF at a time.', true);
    return;
  }
  const [file] = files;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showMessage(uploadStatus, 'Choose a PDF file.', true);
    return;
  }
  if (file.size > 25_000_000) {
    showMessage(uploadStatus, 'This PDF is over 25 MB. Choose a smaller file.', true);
    return;
  }

  reading = true;
  results.hidden = true;
  if (workbookUrl) URL.revokeObjectURL(workbookUrl);
  workbookUrl = null;
  download.removeAttribute('href');
  download.hidden = true;
  showMessage(downloadStatus, '');
  byId('empty-upload').hidden = true;
  byId('active-upload').hidden = false;
  byId('file-name').textContent = file.name;
  byId('file-meta').textContent = 'Reading PDF…';
  zone.classList.add('has-file');
  zone.setAttribute('aria-busy', 'true');
  replace.disabled = true;
  progress.removeAttribute('value');
  progress.hidden = false;
  showMessage(uploadStatus, '');

  try {
    const {report, pages} = await readPdf(file);
    byId('file-meta').textContent = pages + (pages === 1 ? ' page · ' : ' pages · ') + number.format(file.size / 1_000) + ' KB';
    renderResult(report);
    if (!report.issues.length) await prepareDownload(file, report);
    showMessage(uploadStatus, report.entries.length + ' cost rows extracted. See the results below.');
    const heading = byId('results-title');
    heading.tabIndex = -1;
    heading.focus({preventScroll: true});
    heading.scrollIntoView({block: 'nearest'});
  } catch (error) {
    console.error('PDF processing failed.', error);
    byId('file-meta').textContent = 'Could not extract costs';
    showMessage(uploadStatus, pdfError(error), true);
  } finally {
    progress.hidden = true;
    replace.disabled = false;
    zone.removeAttribute('aria-busy');
    reading = false;
  }
}

byId('choose-file').addEventListener('click', () => input.click());
replace.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const files = [...input.files];
  input.value = '';
  void selectFiles(files);
});
zone.addEventListener('dragover', event => {
  event.preventDefault();
  if (!reading) zone.classList.add('drag-over');
});
zone.addEventListener('dragleave', event => {
  if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
});
zone.addEventListener('drop', event => {
  event.preventDefault();
  zone.classList.remove('drag-over');
  void selectFiles([...event.dataTransfer.files]);
});

