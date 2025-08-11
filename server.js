// server.js
// Backend que obtiene la tabla mensual (DieselOGasolina / SeisEnLinea) y la sirve como JSON.
// Requisitos: node 16+
// npm i express node-fetch@2 cheerio node-cache cors

const express = require('express');
const fetch = require('node-fetch'); // v2
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const CACHE_KEY = 'matriculas';
const cache = new NodeCache({ stdTTL: 60 * 60 * 6 }); // cache 6h

// FUENTES: ajusta estas URL si quieres otra fuente
const SOURCES = [
  'https://www.dieselogasolina.com/tabla-matriculas-por-anos.html',
  'https://www.seisenlinea.com/edad-matriculas/'
];

const DATA_FILE = path.join(__dirname, 'data', 'matriculas_monthly.json');

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function capitalize(s){ if(!s) return s; return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase(); }
function monthIndex(m){ return MONTHS_ES.indexOf(capitalize(m)); }

// Normaliza un token de serie a mayúsculas sólo letras
function normSerie(s){ return (s||'').replace(/[^A-Z]/gi,'').toUpperCase(); }

// Intento tolerante de parseo: busca patrones "Mes Año ... XXX" en el HTML
async function parseMonthlyFromHtml(html){
  const monthly = [];
  // 1) intento con cheerio para tablas
  try {
    const $ = cheerio.load(html);
    $('table').each((i, table) => {
      $(table).find('tr').each((ri, tr) => {
        const cols = $(tr).find('td, th').map((ci, td) => $(td).text().trim()).get();
        if(cols.length >= 2){
          const line = cols.join(' | ');
          const r = extractMonthYearSerie(line);
          if(r) monthly.push(r);
        }
      });
    });
  } catch(e){
    // ignore
  }

  // 2) Si no encuentra en tablas -> regex global sobre HTML
  if(monthly.length === 0){
    const reGlobal = /(?:Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)[^0-9]{0,10}\d{4}[^A-Z0-9]{0,40}[A-Z]{2,3}/gi;
    let match;
    while((match = reGlobal.exec(html)) !== null){
      const found = match[0];
      const r = extractMonthYearSerie(found);
      if(r) monthly.push(r);
    }
  }

  // deduplicate & normalize
  const uniq = [];
  const seen = new Set();
  for(const m of monthly){
    const key = `${m.año}-${m.mes}-${m.fin}`;
    if(!seen.has(key)){
      seen.add(key);
      uniq.push(m);
    }
  }

  // ordenar asc por año/mes
  uniq.sort((a,b) => (a.año - b.año) || (monthIndex(a.mes) - monthIndex(b.mes)));
  return uniq;
}

// Extrae {mes, año, fin} de una cadena si encaja
function extractMonthYearSerie(text){
  const monthNames = '(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)';
  // patrones posibles: "Enero 2024 ... MFX" o "2024 - Enero - MFX"
  let rx1 = new RegExp(`${monthNames}\\s+(\\d{4}).{0,40}?([A-Z]{2,3})`, 'i');
  let m = text.match(rx1);
  if(m){
    return { mes: capitalize(m[1]), año: parseInt(m[2],10), fin: normSerie(m[3]) };
  }
  let rx2 = new RegExp(`(\\d{4}).{0,20}?${monthNames}.{0,40}?([A-Z]{2,3})`, 'i');
  m = text.match(rx2);
  if(m){
    return { mes: capitalize(m[2]), año: parseInt(m[1],10), fin: normSerie(m[3]) };
  }
  // fallback: buscar año y serie
  let rx3 = new RegExp(`(\\d{4}).{0,40}?([A-Z]{2,3})`, 'i');
  m = text.match(rx3);
  if(m){
    return { mes: '??', año: parseInt(m[1],10), fin: normSerie(m[2]) };
  }
  return null;
}

// Try to fetch and parse sources; if fail, try to load local file
async function buildMonthly(){
  // 1) try cache
  const cached = cache.get(CACHE_KEY);
  if(cached) return cached;

  let monthly = [];
  for(const src of SOURCES){
    try {
      const r = await fetch(src, { headers: { 'User-Agent': 'node.js' }});
      if(!r.ok) continue;
      const html = await r.text();
      const parsed = await parseMonthlyFromHtml(html);
      if(parsed && parsed.length) {
        monthly = monthly.concat(parsed);
      }
    } catch(err) {
      console.warn('Error fetching', src, err.message);
    }
  }

  // normalize & unique & sort
  monthly = monthly.map(m => ({ mes: m.mes, año: m.año, fin: normSerie(m.fin) }));
  const map = new Map();
  monthly.forEach(m => {
    const k = `${m.año}-${m.mes}-${m.fin}`;
    map.set(k, m);
  });
  monthly = Array.from(map.values()).sort((a,b) => (a.año-b.año) || (monthIndex(a.mes)-monthIndex(b.mes)));

  // if still empty, try local JSON file as fallback
  if(monthly.length === 0){
    try {
      const file = fs.readFileSync(DATA_FILE, 'utf8');
      const obj = JSON.parse(file);
      if(obj && Array.isArray(obj.monthly)) monthly = obj.monthly;
    } catch(e){
      console.warn('No local data file or read error:', e.message);
    }
  }

  // cache & return
  cache.set(CACHE_KEY, monthly);
  return monthly;
}

// Endpoint
app.get('/api/matriculas', async (req,res) => {
  try {
    const monthly = await buildMonthly();
    res.json({ 
      ok: true, 
      source: 'combined', 
      data: { monthly }
    });
  } catch(err){
    res.status(500).json({ ok:false, error: err.message });
  }
});

// Simple health check
app.get('/', (req,res) => res.send('Matriculas API OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
