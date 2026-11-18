import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import promptSync from 'prompt-sync';
import sanitize from 'sanitize-filename';

const prompt = promptSync({ sigint: true });

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const BASE_API = 'https://loeda.loescher.it';

export async function loginLoescher(username, password) {
  const res = await fetch(`${BASE_API}/loescher/api/v2/api-token-auth/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      username,
      password,
      app: 'mylim'
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.non_field_errors?.[0] || `Login failed with status ${res.status}`);
  }

  const token = data.token || data.token_loescher;
  if (!token) {
    throw new Error('Token JWT mancante nella risposta del server');
  }

  return token;
}

export async function fetchLoescherBooks(token) {
  const headers = {
    'Authorization': `JWT ${token}`,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
  };

  const res = await fetch(`${BASE_API}/mialim2/api/v1/book/sommari/`, { headers });
  if (!res.ok) {
    throw new Error(`Impossibile recuperare l'elenco dei libri (HTTP ${res.status})`);
  }

  const items = await res.json();
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter(item => item && item.opera && item.opera.isbn)
    .map(item => {
      const opera = item.opera;
      const isDemo = item.tipologia === 'd' || String(opera.isbn).endsWith('_demo');
      const pdfPath = opera.pdf || (opera.isbn ? `/mialim2/api/v1/book/pdf/${opera.isbn}.pdf` : null);
      return {
        id: opera.id,
        isbn: String(opera.isbn),
        title: opera.nome || opera.titolo || `Libro ${opera.isbn}`,
        author: opera.autore || '',
        isDemo,
        pdfPath,
        hasPdf: Boolean(opera.pdf)
      };
    });
}

export function filterDownloadableLoescherBooks(books) {
  const owned = books.filter(b => b.hasPdf && !b.isDemo);
  if (owned.length > 0) {
    return owned;
  }
  return books
    .filter(b => b.hasPdf)
    .map(b => ({ ...b, title: `[DEMO] ${b.title}` }));
}

async function downloadFileWithProgress(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!res.ok) {
    throw new Error(`Download del PDF fallito (HTTP ${res.status})`);
  }

  const totalBytes = Number(res.headers.get('content-length')) || 0;
  let downloadedBytes = 0;
  let lastLoggedPercent = -1;

  const fileStream = fs.createWriteStream(destPath);
  const bodyStream = Readable.fromWeb(res.body);

  bodyStream.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0) {
      const percent = Math.floor((downloadedBytes / totalBytes) * 100);
      if (percent >= lastLoggedPercent + 5 || percent === 100) {
        lastLoggedPercent = percent;
        console.log(`Downloading PDF... ${percent}%`);
      }
    }
  });

  bodyStream.pipe(fileStream);
  await finished(fileStream);
}

export async function run(options = {}) {
  const argv = yargs(hideBin(process.argv.slice(2)))
    .option('username', {
      alias: 'u',
      type: 'string',
      description: 'Username or email for Loescher / Imparosulweb'
    })
    .option('password', {
      alias: 'p',
      type: 'string',
      description: 'Password'
    })
    .option('token', {
      alias: 't',
      type: 'string',
      description: 'JWT Token (per accesso diretto / Zaino Digitale)'
    })
    .option('isbn', {
      alias: 'i',
      type: 'string',
      description: 'ISBN del libro da scaricare'
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Nome del file PDF di output (opzionale)'
    })
    .help()
    .argv;

  let token = options.token || argv.token || process.env.LOESCHER_TOKEN;
  let username = options.username || argv.username;
  let password = options.password || argv.password;
  let isbn = options.isbn || argv.isbn;
  const outputFilename = options.output || argv.output;
  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

  if (!token) {
    while (!username && !token) {
      const input = prompt('Email o Username Imparosulweb (oppure incolla il Token JWT): ');
      if (input && input.length > 50 && input.includes('.')) {
        token = input.trim();
        break;
      }
      username = input ? input.trim() : '';
    }

    if (!token) {
      while (!password) {
        password = prompt('Password: ', { echo: '*' });
      }

      console.log('Logging in...');
      try {
        token = await loginLoescher(username, password);
      } catch (err) {
        console.log(`\n❌ Login fallito: ${err.message}`);
        console.log('💡 Se accedi con Zaino Digitale o SSO e non hai una password Loescher:');
        console.log('   1. Accedi a https://mylim.loescher.it dal browser.');
        console.log('   2. Apri DevTools (F12) -> Rete (Network) -> copia il token dopo "JWT " nell\'header Authorization.');
        console.log('   3. Inseriscilo nelle Opzioni avanzate (o usa --token).\n');
        process.exit(1);
      }
    }
  }

  const authHeaders = {
    'Authorization': `JWT ${token}`,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
  };

  try {
    const userRes = await fetch(`${BASE_API}/loescher/api/v1/user/data/`, { headers: authHeaders });
    if (userRes.ok) {
      const userData = await userRes.json();
      const fullName = [userData.nome, userData.cognome].filter(Boolean).join(' ') || userData.username;
      if (fullName) {
        console.log(`Logged in as: ${fullName}`);
      }
    }
  } catch {
    // Non-critical if user info call fails
  }

  console.log('Fetching available books...');
  let books = [];
  try {
    books = await fetchLoescherBooks(token);
  } catch (err) {
    console.log('Error:', err.message);
    process.exit(1);
  }

  const downloadableBooks = filterDownloadableLoescherBooks(books);
  if (downloadableBooks.length === 0) {
    console.log('No downloadable PDF books found');
    process.exit(0);
  }

  console.log('Available books:');
  console.table(
    Object.fromEntries(downloadableBooks.map(b => [b.isbn, { title: b.title }])),
    ['title']
  );

  while (!isbn) {
    isbn = prompt('ISBN: ').trim();
  }

  const selectedBook = downloadableBooks.find(b => b.isbn === isbn);
  if (!selectedBook) {
    console.log(`ISBN ${isbn} non trovato tra i libri scaricabili.`);
    process.exit(1);
  }

  console.log(`Selezionato: ${selectedBook.title} (${selectedBook.isbn})`);
  console.log('Requesting PDF download URL...');

  const pdfEndpoint = selectedBook.pdfPath.startsWith('http')
    ? selectedBook.pdfPath
    : `${BASE_API}${selectedBook.pdfPath.startsWith('/') ? '' : '/'}${selectedBook.pdfPath}`;

  const pdfMetaRes = await fetch(pdfEndpoint, { headers: authHeaders });
  if (!pdfMetaRes.ok) {
    console.log(`❌ Errore nella richiesta del link PDF (HTTP ${pdfMetaRes.status})`);
    process.exit(1);
  }

  const pdfMeta = await pdfMetaRes.json();
  if (!pdfMeta || !pdfMeta.url) {
    console.log('❌ URL di download PDF non presente nella risposta:', JSON.stringify(pdfMeta));
    process.exit(1);
  }

  await fs.promises.mkdir(outputDir, { recursive: true });
  const safeName = sanitize(outputFilename || selectedBook.title).replace(/\s+/g, '_') || selectedBook.isbn;
  const finalName = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
  const outputPath = path.join(outputDir, finalName);

  console.log(`Downloading PDF to ${outputPath}...`);
  await downloadFileWithProgress(pdfMeta.url, outputPath);

  console.log(`Done! PDF saved: ${outputPath}`);
  console.log(`OURBOOKS_OUTPUT:${outputPath}`);
}
