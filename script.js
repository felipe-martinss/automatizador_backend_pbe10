/* ==========================================================
   Otimizador BackEnd — gera um CRUD Node + Express + MySQL
   a partir de um script SQL, com coleção do Insomnia.
   ========================================================== */

/* ---------- 1. Leitura do SQL ---------- */

function limparSql(sql) {
  let saida = '';
  let aspa = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const prox = sql[i + 1];

    if (aspa) {
      saida += c;
      if (c === '\\' && aspa !== '`') {
        saida += prox ?? '';
        i++;
      } else if (c === aspa) {
        aspa = null;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      aspa = c;
      saida += c;
      continue;
    }
    if ((c === '-' && prox === '-' && /\s/.test(sql[i + 2] ?? ' ')) || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      saida += '\n';
      continue;
    }
    if (c === '/' && prox === '*') {
      const fim = sql.indexOf('*/', i + 2);
      i = fim === -1 ? sql.length : fim + 1;
      saida += ' ';
      continue;
    }
    saida += c;
  }
  return saida;
}

function extrairParenteses(texto, indiceAbre) {
  let nivel = 0;
  let aspa = null;
  for (let i = indiceAbre; i < texto.length; i++) {
    const c = texto[i];
    if (aspa) {
      if (c === '\\' && aspa !== '`') i++;
      else if (c === aspa) aspa = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { aspa = c; continue; }
    if (c === '(') nivel++;
    if (c === ')') {
      nivel--;
      if (nivel === 0) return { corpo: texto.slice(indiceAbre + 1, i), fim: i };
    }
  }
  return null;
}

function dividirNoTopo(texto) {
  const partes = [];
  let atual = '';
  let nivel = 0;
  let aspa = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspa) {
      atual += c;
      if (c === '\\' && aspa !== '`') { atual += texto[i + 1] ?? ''; i++; }
      else if (c === aspa) aspa = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { aspa = c; atual += c; continue; }
    if (c === '(') nivel++;
    if (c === ')') nivel--;
    if (c === ',' && nivel === 0) { partes.push(atual.trim()); atual = ''; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

function extrairTabelas(sql) {
  const limpo = limparSql(sql);
  const cabecalho = /CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\s*\.\s*)?`?(\w+)`?\s*\(/gi;
  const tabelas = [];
  let m;

  while ((m = cabecalho.exec(limpo)) !== null) {
    const nome = m[1];
    const abre = m.index + m[0].length - 1;
    const bloco = extrairParenteses(limpo, abre);
    if (!bloco) continue;
    cabecalho.lastIndex = bloco.fim + 1;

    const colunas = [];
    let pkTabela = [];

    for (const def of dividirNoTopo(bloco.corpo)) {
      const mPk = def.match(/^(?:CONSTRAINT\s+`?\w+`?\s+)?PRIMARY\s+KEY\s*(?:\w+\s*)?\(([^)]+)\)/i);
      if (mPk) {
        pkTabela = mPk[1].split(',').map(s => s.replace(/`/g, '').trim().split(/[\s(]/)[0]);
        continue;
      }
      if (/^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CHECK)\b/i.test(def)) continue;

      const mCol = def.match(/^`?(\w+)`?\s+(\w+)/);
      if (!mCol) continue;

      const tipo = mCol[2].toLowerCase();
      const pkInline = /\bPRIMARY\s+KEY\b/i.test(def);
      const autoInc = /\bAUTO_INCREMENT\b/i.test(def) || tipo === 'serial';
      const gerada = /\bGENERATED\s+ALWAYS\b|\bAS\s*\(/i.test(def);
      const mEnum = def.match(/\benum\s*\(([^)]*)\)/i);

      colunas.push({
        nome: mCol[1],
        tipo,
        pk: pkInline,
        autoInc,
        gerada,
        notNull: /\bNOT\s+NULL\b/i.test(def) || pkInline,
        temDefault: /\bDEFAULT\b/i.test(def),
        enumValores: mEnum ? [...mEnum[1].matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map(x => x[1]) : []
      });
    }

    pkTabela.forEach(p => {
      const col = colunas.find(c => c.nome.toLowerCase() === p.toLowerCase());
      if (col) { col.pk = true; col.notNull = true; }
    });

    const colPk = colunas.find(c => c.pk);
    const campos = colunas.filter(c => !c.autoInc && !c.gerada);

    tabelas.push({
      nome,
      chave: colPk ? colPk.nome : 'id',
      campos: campos.map(c => c.nome),
      obrigatorios: campos.filter(c => c.notNull && !c.temDefault).map(c => c.nome),
      colunas
    });
  }
  return tabelas;
}

function extrairNomeBanco(sql) {
  const limpo = limparSql(sql);
  const criar = limpo.match(/CREATE\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
  if (criar) return criar[1];
  const usar = limpo.match(/\bUSE\s+`?(\w+)`?/i);
  return usar ? usar[1] : 'meu_banco';
}

/* ---------- 2. Geração dos arquivos ---------- */

function valorExemplo(col) {
  const nome = col.nome.toLowerCase();
  if (/mail/.test(nome)) return 'exemplo@email.com';
  if (/senha|password/.test(nome)) return 'senha123';
  if (col.enumValores.length) return col.enumValores[0];

  switch (col.tipo) {
    case 'tinyint': case 'smallint': case 'mediumint':
    case 'int': case 'integer': case 'bigint': case 'bit':
    case 'bool': case 'boolean':
      return 1;
    case 'decimal': case 'numeric': case 'float': case 'double': case 'real':
      return 10.5;
    case 'date': return '2026-01-01';
    case 'datetime': case 'timestamp': return '2026-01-01 12:00:00';
    case 'time': return '12:00:00';
    case 'year': return 2026;
    case 'json': return {};
    default: return 'exemplo';
  }
}

function gerarController(tab) {
  const cols = tab.campos.join(', ');
  const placeholders = tab.campos.map(() => '?').join(', ');
  const updates = tab.campos.map(c => `${c} = ?`).join(', ');

  return `const db = require('../db');

const listar = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM ${tab.nome}');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const buscarPorId = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM ${tab.nome} WHERE ${tab.chave} = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const criar = async (req, res) => {
  const { ${tab.campos.join(', ')} } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO ${tab.nome} (${cols}) VALUES (${placeholders})',
      [${tab.campos.join(', ')}]
    );
    res.status(201).json({ id: result.insertId, ...req.body });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const atualizar = async (req, res) => {
  const { id } = req.params;
  const { ${tab.campos.join(', ')} } = req.body;
  try {
    await db.query(
      'UPDATE ${tab.nome} SET ${updates} WHERE ${tab.chave} = ?',
      [${tab.campos.length ? tab.campos.join(', ') + ', ' : ''}id]
    );
    res.json({ mensagem: 'Atualizado com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const deletar = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM ${tab.nome} WHERE ${tab.chave} = ?', [id]);
    res.json({ mensagem: 'Removido com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

module.exports = { listar, buscarPorId, criar, atualizar, deletar };
`;
}

function gerarDb(dbName) {
  return `const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '${dbName}',
  decimalNumbers: true,
  dateStrings: true
});

module.exports = pool;
`;
}

const ARQUIVO_SERVER = `const express = require('express');
const cors = require('cors');
const routes = require('./src/routes');

const app = express();
app.use(cors());
app.use(express.json());
app.use(routes);

app.listen(3000, () => {
  console.log('Servidor rodando na porta 3000');
});
`;

function gerarInsomnia(dbName, tabelas) {
  const agora = Date.now();
  const base = 'http://localhost:3000';
  const workspaceId = 'wrk_' + dbName;
  const recursos = [{
    _id: workspaceId,
    parentId: null,
    modified: agora,
    created: agora,
    name: `API ${dbName} - StatTrak`,
    description: 'Coleção gerada automaticamente',
    scope: 'collection',
    _type: 'workspace'
  }];

  const requisicao = (id, pasta, ordem, nome, metodo, url, corpo) => ({
    _id: id,
    parentId: pasta,
    modified: agora,
    created: agora,
    url,
    name: nome,
    description: '',
    method: metodo,
    body: corpo ? { mimeType: 'application/json', text: JSON.stringify(corpo, null, 2) } : {},
    parameters: [],
    headers: corpo ? [{ name: 'Content-Type', value: 'application/json' }] : [],
    authentication: {},
    metaSortKey: ordem,
    _type: 'request'
  });

  tabelas.forEach((tab, i) => {
    const exemplo = {};
    tab.colunas.filter(c => !c.autoInc && !c.gerada).forEach(c => { exemplo[c.nome] = valorExemplo(c); });

    const pasta = `fld_${dbName}_${tab.nome}`;
    const rota = `${base}/${tab.nome}`;

    recursos.push({
      _id: pasta,
      parentId: workspaceId,
      modified: agora,
      created: agora,
      name: tab.nome.toUpperCase(),
      description: `Rotas CRUD para a tabela ${tab.nome}`,
      environment: {},
      environmentPropertyOrder: null,
      metaSortKey: -1000 * (tabelas.length - i),
      _type: 'request_group'
    });
    recursos.push(requisicao(`req_${tab.nome}_listar`, pasta, -5, `Listar ${tab.nome}`, 'GET', rota));
    recursos.push(requisicao(`req_${tab.nome}_buscar`, pasta, -4, `Buscar ${tab.nome} por id`, 'GET', `${rota}/1`));
    recursos.push(requisicao(`req_${tab.nome}_criar`, pasta, -3, `Criar ${tab.nome}`, 'POST', rota, exemplo));
    recursos.push(requisicao(`req_${tab.nome}_atualizar`, pasta, -2, `Atualizar ${tab.nome}`, 'PUT', `${rota}/1`, exemplo));
    recursos.push(requisicao(`req_${tab.nome}_deletar`, pasta, -1, `Deletar ${tab.nome}`, 'DELETE', `${rota}/1`));
  });

  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'Otimizador StatTrak v1.1',
    resources: recursos
  };
}

/* ---------- 3. Botão "Gerar back-end" ---------- */

function paraBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  bytes.forEach(b => { binario += String.fromCharCode(b); });
  return btoa(binario);
}

function gerarBackend() {
  const saida = document.getElementById('terminal-output');
  const secao = document.getElementById('output-section');
  const sql = document.getElementById('sql-input').value.trim();

  if (!sql) {
    alert('Cole algum código SQL primeiro!');
    return;
  }

  const dbName = extrairNomeBanco(sql);
  const tabelas = extrairTabelas(sql);

  if (tabelas.length === 0) {
    alert('Nenhuma instrução CREATE TABLE válida encontrada no SQL.');
    return;
  }

  const arquivos = {};
  arquivos['db/script.sql'] = sql;
  arquivos['docs/der_energia.sql'] = sql;
  arquivos['src/db.js'] = gerarDb(dbName);

  let importsRoutes = `const express = require('express');\nconst router = express.Router();\n\n`;
  tabelas.forEach(tab => {
    arquivos[`src/controllers/${tab.nome}.js`] = gerarController(tab);
    importsRoutes += `const ${tab.nome}Controller = require('./controllers/${tab.nome}');\n`;
    importsRoutes += `router.get('/${tab.nome}', ${tab.nome}Controller.listar);\n`;
    importsRoutes += `router.get('/${tab.nome}/:id', ${tab.nome}Controller.buscarPorId);\n`;
    importsRoutes += `router.post('/${tab.nome}', ${tab.nome}Controller.criar);\n`;
    importsRoutes += `router.put('/${tab.nome}/:id', ${tab.nome}Controller.atualizar);\n`;
    importsRoutes += `router.delete('/${tab.nome}/:id', ${tab.nome}Controller.deletar);\n\n`;
  });
  importsRoutes += `module.exports = router;`;

  arquivos['src/routes.js'] = importsRoutes;
  arquivos['server.js'] = ARQUIVO_SERVER;
  arquivos['.gitignore'] = 'node_modules\npackage-lock.json\n';
  arquivos['insomnia.json'] = JSON.stringify(gerarInsomnia(dbName, tabelas), null, 2);

  const linhas = [];
  linhas.push('mkdir db, docs, src, src\\controllers -Force | Out-Null');
  linhas.push('npm init -y | Out-Null');

  for (const [caminho, conteudo] of Object.entries(arquivos)) {
    const alvo = caminho.replace(/\//g, '\\');
    linhas.push(`[IO.File]::WriteAllBytes("$PWD\\${alvo}", [Convert]::FromBase64String("${paraBase64(conteudo)}"))`);
  }

  linhas.push('npm pkg set scripts.start="node server.js"');
  linhas.push('npm pkg set scripts.dev="node --watch server.js"');
  linhas.push('npm install express cors mysql2');
  linhas.push('Write-Host "Back-end gerado com sucesso na estrutura solicitada! Rode npm run dev para iniciar." -ForegroundColor Green');

  saida.textContent = linhas.join('\n');
  secao.style.display = 'flex';

  const botao = document.getElementById('btn-copy');
  if (botao) botao.textContent = 'Copiar Comando';
}

/* ---------- 4. Botão "Copiar Comando" ---------- */

async function copiarComando() {
  const texto = document.getElementById('terminal-output').textContent;
  const botao = document.getElementById('btn-copy');
  if (!texto) return;

  let copiou = false;
  try {
    await navigator.clipboard.writeText(texto);
    copiou = true;
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = texto;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { copiou = document.execCommand('copy'); } catch (e2) { copiou = false; }
    document.body.removeChild(area);
  }

  if (botao) {
    botao.textContent = copiou ? 'Copiado!' : 'Falhou — selecione manualmente';
    setTimeout(() => { botao.textContent = 'Copiar Comando'; }, 2000);
  }
}