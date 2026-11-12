
// ============================================================
// Otimizador StatTrak — gerador de back-end (Node + Express + MySQL)
// Estrutura gerada: config / controllers / models / routes
// ============================================================

let ultimoComando = '';

// ---------- Utilitários ----------

// Envolve identificadores em crases
const q = (nome) => '`' + nome + '`';

// Base64 seguro para UTF-8
function paraBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function removerComentarios(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

// Divide por vírgulas apenas no nível zero
function dividirNivelZero(texto) {
  const partes = [];
  let atual = '';
  let nivel = 0;
  let aspas = null;

  for (const ch of texto) {
    if (aspas) {
      atual += ch;
      if (ch === aspas) aspas = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      aspas = ch;
      atual += ch;
      continue;
    }

    if (ch === '(') nivel++;
    if (ch === ')') nivel--;

    if (ch === ',' && nivel === 0) {
      partes.push(atual.trim());
      atual = '';
      continue;
    }

    atual += ch;
  }

  if (atual.trim()) partes.push(atual.trim());

  return partes;
}

// ---------- Parser do SQL ----------

function analisarTabela(nome, corpo) {
  const colunas = [];
  const pks = [];

  for (const parte of dividirNivelZero(corpo)) {

    const pkTabela = parte.match(
      /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i
    );

    if (pkTabela) {
      pkTabela[1].split(',').forEach((c) =>
        pks.push(c.replace(/[`"\s]/g, ''))
      );
      continue;
    }

    if (/^(CONSTRAINT|FOREIGN|KEY|UNIQUE|INDEX|FULLTEXT|SPATIAL|CHECK)\b/i.test(parte)) {
      continue;
    }

    const col = parte.match(/^[`"]?(\w+)[`"]?\s+(\w+)/);

    if (!col) continue;

    if (/PRIMARY\s+KEY/i.test(parte)) {
      pks.push(col[1]);
    }

    colunas.push({
      nome: col[1],
      tipo: col[2],
      auto: /AUTO_INCREMENT/i.test(parte),
      notNull: /NOT\s+NULL/i.test(parte),
      temDefault: /\bDEFAULT\b/i.test(parte)
    });
  }

  const pk =
    pks[0] ||
    (colunas.find((c) => c.auto) || {}).nome ||
    'id';

  const insertaveis = colunas.filter((c) => !c.auto);

  const atualizaveis = insertaveis.filter(
    (c) => c.nome !== pk
  );

  const obrigatoria = (c) =>
    !c.temDefault && (c.notNull || pks.includes(c.nome));

  return {
    nome,
    pk,
    colunas,
    insertaveis,
    atualizaveis,
    obrigatoriosCriar: insertaveis.filter(obrigatoria).map((c) => c.nome),
    obrigatoriosAtualizar: atualizaveis.filter(obrigatoria).map((c) => c.nome)
  };
}

// ---------- Extrair tabelas ----------

function extrairTabelas(sql) {
  const limpo = removerComentarios(sql);

  const cabecalho =
    /CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?\s*\(/gi;

  const tabelas = [];
  let m;

  while ((m = cabecalho.exec(limpo)) !== null) {
    const inicio = cabecalho.lastIndex;
    let i = inicio;
    let nivel = 1;
    let aspas = null;

    for (; i < limpo.length && nivel > 0; i++) {
      const ch = limpo[i];

      if (aspas) {
        if (ch === aspas) aspas = null;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        aspas = ch;
      } else if (ch === '(') {
        nivel++;
      } else if (ch === ')') {
        nivel--;
      }
    }

    cabecalho.lastIndex = i;

    tabelas.push(
      analisarTabela(m[1], limpo.slice(inicio, i - 1))
    );
  }

  return tabelas;
}

// ---------- Geradores de arquivos ----------

// Conexão com MySQL
function gerarConfigDb(dbName) {
  return `const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: '${dbName}',
  waitForConnections: true,
  connectionLimit: 10
});

module.exports = pool;
`;
}

// Model
function gerarModel(tab) {
  const t = q(tab.nome);
  const pk = q(tab.pk);

  const cols = tab.insertaveis
    .map((c) => q(c.nome))
    .join(', ');

  const marks = tab.insertaveis
    .map(() => '?')
    .join(', ');

  const sets = tab.atualizaveis
    .map((c) => q(c.nome) + ' = ?')
    .join(', ');

  const valoresInsert = tab.insertaveis
    .map((c) => `dados.${c.nome} ?? null`)
    .join(', ');

  const valoresUpdate = [
    ...tab.atualizaveis.map((c) => `dados.${c.nome} ?? null`),
    'id'
  ].join(', ');

  return `const db = require('../config/db');

const listar = async () => {
  const [rows] = await db.query('SELECT * FROM ${t}');
  return rows;
};

const buscarPorId = async (id) => {
  const [rows] = await db.query(
    'SELECT * FROM ${t} WHERE ${pk} = ?',
    [id]
  );
  return rows[0];
};

const criar = async (dados) => {
  const [result] = await db.query(
    'INSERT INTO ${t} (${cols}) VALUES (${marks})',
    [${valoresInsert}]
  );
  return result.insertId;
};

const atualizar = async (id, dados) => {
  const [result] = await db.query(
    'UPDATE ${t} SET ${sets} WHERE ${pk} = ?',
    [${valoresUpdate}]
  );
  return result.affectedRows;
};

const remover = async (id) => {
  const [result] = await db.query(
    'DELETE FROM ${t} WHERE ${pk} = ?',
    [id]
  );
  return result.affectedRows;
};

module.exports = {
  listar,
  buscarPorId,
  criar,
  atualizar,
  remover
};
`;
}

// Controller
function gerarController(tab) {
  return `const model = require('../models/${tab.nome}');

const OBRIGATORIOS_CRIAR = ${JSON.stringify(tab.obrigatoriosCriar)};
const OBRIGATORIOS_ATUALIZAR = ${JSON.stringify(tab.obrigatoriosAtualizar)};

const faltando = (body, lista) =>
  lista.filter((c) =>
    body[c] === undefined ||
    body[c] === null ||
    body[c] === ''
  );

const listar = async (req, res) => {
  try {
    res.json(await model.listar());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const buscarPorId = async (req, res) => {
  try {
    const registro = await model.buscarPorId(req.params.id);

    if (!registro) {
      return res.status(404).json({
        erro: 'Registro não encontrado'
      });
    }

    res.json(registro);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const criar = async (req, res) => {
  const ausentes = faltando(req.body, OBRIGATORIOS_CRIAR);

  if (ausentes.length) {
    return res.status(400).json({
      erro: 'Campos obrigatórios ausentes',
      campos: ausentes
    });
  }

  try {
    const id = await model.criar(req.body);

    res.status(201).json({
      id,
      ...req.body
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const atualizar = async (req, res) => {
  const ausentes = faltando(req.body, OBRIGATORIOS_ATUALIZAR);

  if (ausentes.length) {
    return res.status(400).json({
      erro: 'Campos obrigatórios ausentes',
      campos: ausentes
    });
  }

  try {
    const afetados = await model.atualizar(
      req.params.id,
      req.body
    );

    if (!afetados) {
      return res.status(404).json({
        erro: 'Registro não encontrado'
      });
    }

    res.json({
      mensagem: 'Atualizado com sucesso'
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

const remover = async (req, res) => {
  try {
    const afetados = await model.remover(req.params.id);

    if (!afetados) {
      return res.status(404).json({
        erro: 'Registro não encontrado'
      });
    }

    res.json({
      mensagem: 'Removido com sucesso'
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};

module.exports = {
  listar,
  buscarPorId,
  criar,
  atualizar,
  remover
};
`;
}

// Rotas individuais
function gerarRotaTabela(tab) {
  return `const express = require('express');
const router = express.Router();
const controller = require('../controllers/${tab.nome}');

router.get('/', controller.listar);
router.get('/:id', controller.buscarPorId);
router.post('/', controller.criar);
router.put('/:id', controller.atualizar);
router.delete('/:id', controller.remover);

module.exports = router;
`;
}

// Index das rotas
function gerarRotasIndex(tabelas) {
  const linhas = tabelas
    .map((t) =>
      `router.use('/${t.nome}', require('./${t.nome}'));`
    )
    .join('\n');

  return `const express = require('express');
const router = express.Router();

${linhas}

module.exports = router;
`;
}

// Servidor Express
function gerarServer() {
  return `const express = require('express');
const cors = require('cors');
const routes = require('./routes');

const app = express();

app.use(cors());
app.use(express.json());
app.use(routes);

// 404 para rotas inexistentes
app.use((req, res) => {
  res.status(404).json({
    erro: 'Rota não encontrada'
  });
});

// JSON inválido e demais erros
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      erro: 'JSON inválido'
    });
  }

  res.status(500).json({
    erro: err.message
  });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
`;
}

// ---------- Função principal ----------

function gerarBackend() {
  const sql = document.getElementById('sql-input').value.trim();

  if (!sql) {
    alert('Cole algum código SQL primeiro!');
    return;
  }

  // 1. Nome do banco
  const dbMatch = sql.match(
    /CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?/i
  );

  const dbName = dbMatch ? dbMatch[1] : 'meu_banco';

  // 2. Extração das tabelas
  const todas = extrairTabelas(sql);

  const tabelas = todas.filter(
    (t) =>
      t.insertaveis.length > 0 &&
      t.atualizaveis.length > 0
  );

  const ignoradas = todas
    .filter((t) => !tabelas.includes(t))
    .map((t) => t.nome);

  if (ignoradas.length) {
    console.warn(
      'Tabelas ignoradas (sem colunas para inserir/atualizar):',
      ignoradas.join(', ')
    );
  }

  if (tabelas.length === 0) {
    alert(
      'Nenhuma instrução CREATE TABLE utilizável encontrada no SQL.'
    );
    return;
  }

  // 3. Geração dos arquivos
  const arquivos = {};

  arquivos['config/script.sql'] = sql;
  arquivos['config/db.js'] = gerarConfigDb(dbName);

  tabelas.forEach((tab) => {
    arquivos['models/' + tab.nome + '.js'] = gerarModel(tab);

    arquivos['controllers/' + tab.nome + '.js'] =
      gerarController(tab);

    arquivos['routes/' + tab.nome + '.js'] =
      gerarRotaTabela(tab);
  });

  arquivos['routes/index.js'] = gerarRotasIndex(tabelas);
  arquivos['server.js'] = gerarServer();

  arquivos['.gitignore'] =
    'node_modules\npackage-lock.json\n.env\n';

  // 4. Comando PowerShell
  let ps =
    'New-Item -ItemType Directory -Force -Path config,controllers,models,routes | Out-Null; ';

  ps += 'npm init -y | Out-Null; ';

  ps +=
    'function W($p,$b){[IO.File]::WriteAllBytes((Join-Path $PWD $p),[Convert]::FromBase64String($b))}; ';

  for (const [caminho, conteudo] of Object.entries(arquivos)) {
    const alvo = caminho.replace(/\//g, '\\');

    const chamada =
      "W '" + alvo + "' '" + paraBase64(conteudo) + "'; ";

    ps += chamada;
  }

  ps +=
    'npm pkg set scripts.start="node server.js"; ';

  ps +=
    'npm pkg set scripts.dev="node --watch server.js"; ';

  ps +=
    'npm install express cors mysql2; ';

  ps +=
    "Write-Host \"Back-end gerado com sucesso! Rode 'npm run dev' para iniciar.\" -ForegroundColor Green";

  ultimoComando = ps;

  document.getElementById('terminal-output').textContent = ps;

  document.getElementById('output-section').style.display = 'flex';
}

// ---------- Ações da interface ----------

async function copiarComando() {
  const texto =
    document.getElementById('terminal-output').textContent;

  const btn = document.getElementById('btn-copy');

  try {
    await navigator.clipboard.writeText(texto);
    btn.textContent = 'Copiado!';
  } catch (err) {
    btn.textContent = 'Falha ao copiar';
  }

  setTimeout(
    () => (btn.textContent = 'Copiar Comando'),
    2000
  );
}

// Baixar script PowerShell
function baixarScript() {
  if (!ultimoComando) {
    alert('Gere o back-end primeiro!');
    return;
  }

  const blob = new Blob(
    [ultimoComando],
    { type: 'text/plain;charset=utf-8' }
  );

  const a = document.createElement('a');

  a.href = URL.createObjectURL(blob);
  a.download = 'gerar-backend.ps1';

  a.click();

  URL.revokeObjectURL(a.href);
}
