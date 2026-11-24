const RISK_COLORS = {
  'BUENO': '#22c55e',
  'ACEPTABLE': '#eab308',
  'MALO': '#f97316',
  'MUY MALO': '#ef4444',
  'EXTREMADAMENTE MALO': '#7e0023'
};

const COLORES = { co2: '#2a78d6', pm25: '#eb6834', pm10: '#1baf7a', temp: '#a78bfa', hum: '#22d3ee' };
const MAX_PUNTOS = 200;   // máximo de puntos por serie en la vista en vivo
const HORAS_VIVO = 24;    // cuánto histórico se carga al entrar a la vista en vivo

// Una sola definición por variable: campo del API, tarjetas, barras y unidad.
// Solo CO2, PM2.5 y PM10 tienen barra de riesgo.
const VARIABLES = {
  co2:  { campo: 'co2Ppm',   tarjeta: 'valCo2',  barra: 'barraCo2',  promedio: 'histCo2Avg',  barraPromedio: 'barraHistCo2',  unidad: 'ppm' },
  pm25: { campo: 'pm25Ugm3', tarjeta: 'valPm25', barra: 'barraPm25', promedio: 'histPm25Avg', barraPromedio: 'barraHistPm25', unidad: 'µg/m³' },
  pm10: { campo: 'pm10Ugm3', tarjeta: 'valPm10', barra: 'barraPm10', promedio: 'histPm10Avg', barraPromedio: 'barraHistPm10', unidad: 'µg/m³' },
  temp: { campo: 'temperaturaC', tarjeta: 'valTemp', promedio: 'histTempAvg', unidad: '°C' },
  hum:  { campo: 'humedadPct',   tarjeta: 'valHum',  promedio: 'histHumAvg',  unidad: '%' }
};

// Límite superior de cada nivel, en el orden de NIVELES. Son los mismos umbrales NOM-172 de
// MotorReglasService.java: si se cambian allá, hay que cambiarlos aquí y en las tablas de "Saber más".
const NIVELES = ['BUENO', 'ACEPTABLE', 'MALO', 'MUY MALO', 'EXTREMADAMENTE MALO'];
const UMBRALES = {
  co2:  [1000, 1500, 2000, 5000],
  pm25: [12.0, 45.0, 97.0, 150.0],
  pm10: [50.0, 75.0, 155.0, 235.0]
};

// Nivel de riesgo de un valor; el límite exacto pertenece al nivel de abajo, igual que en el backend
function nivelDeVariable(clave, valor) {
  const limites = UMBRALES[clave];
  if (!limites || valor == null || Number.isNaN(Number(valor))) return null;
  const indice = limites.findIndex(limite => valor <= limite);
  return NIVELES[indice === -1 ? limites.length : indice];
}

let nodoSeleccionado = 'general';
let vistaActual = 'live';
let contadorSeleccion = 0;   // descarta respuestas de selecciones anteriores
let contadorHistorico = 0;

// ---------- Series de datos ----------
// Cada serie es una lista de puntos {x: milisegundos, y: valor}. Solo hay puntos para los
// mensajes que traían esa variable, así que un mensaje parcial no deja huecos en las demás.
function nuevaSerie() {
  return { co2: [], pm25: [], pm10: [], temp: [], hum: [] };
}
const vivo = nuevaSerie();

function insertarOrdenado(serie, punto) {
  let i = serie.length;
  while (i > 0 && serie[i - 1].x > punto.x) i--;
  serie.splice(i, 0, punto);
}

function agregarPuntos(series, lectura) {
  const x = Date.parse(lectura.timestampOrigen);
  if (Number.isNaN(x)) return;
  Object.entries(VARIABLES).forEach(([clave, v]) => {
    if (lectura[v.campo] != null) insertarOrdenado(series[clave], { x, y: lectura[v.campo] });
  });
}

function aSeries(datos) {
  const series = nuevaSerie();
  datos.forEach(d => agregarPuntos(series, d));
  return series;
}

function limitarSeries(series) {
  Object.values(series).forEach(serie => {
    while (serie.length > MAX_PUNTOS) serie.shift();
  });
}

// ---------- Gráficas ----------
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chartInstance) {
    const tooltip = chartInstance.tooltip;
    if (!tooltip || !tooltip.opacity) return;
    const activePoint = tooltip.getActiveElements()[0];
    if (!activePoint) return;
    const x = activePoint.element.x;
    const { top, bottom } = chartInstance.chartArea;
    const ctx = chartInstance.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#8a93ab66';
    ctx.stroke();
    ctx.restore();
  }
};
Chart.register(crosshairPlugin);

const FORMATOS_TIEMPO = {
  millisecond: 'HH:mm:ss', second: 'HH:mm:ss', minute: 'HH:mm', hour: 'HH:mm',
  day: 'dd/MM', week: 'dd/MM', month: 'MM/yyyy', quarter: 'MM/yyyy', year: 'yyyy'
};

function escalaTiempo() {
  return {
    type: 'time',
    time: { tooltipFormat: 'dd/MM/yyyy HH:mm:ss', displayFormats: FORMATOS_TIEMPO },
    grid: { display: false },
    ticks: { color: '#8a93ab', font: { size: 11 }, maxTicksLimit: 8, maxRotation: 0 }
  };
}

function opcionesBase() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    // El punto más cercano en el tiempo: las series no comparten los mismos instantes
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: '#1a2338',
        titleColor: '#e8ecf5',
        titleFont: { size: 12, weight: '600' },
        bodyColor: '#e8ecf5',
        bodyFont: { size: 13 },
        padding: 10,
        cornerRadius: 6,
        displayColors: false,
        borderColor: '#232e48',
        borderWidth: 1,
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}${ctx.dataset.unidad ? ' ' + ctx.dataset.unidad : ''}`
        }
      }
    },
    scales: {
      x: escalaTiempo(),
      y: { grid: { color: '#232e48' }, ticks: { color: '#8a93ab', font: { size: 11 } } }
    }
  };
}

// Temperatura y humedad tienen unidades distintas: cada una con su propio eje
function opcionesAmbiente() {
  const opciones = opcionesBase();
  delete opciones.scales.y;
  opciones.scales.yTemp = {
    position: 'left',
    grid: { color: '#232e48' },
    ticks: { color: COLORES.temp, font: { size: 11 }, callback: (v) => `${v}°` }
  };
  opciones.scales.yHum = {
    position: 'right',
    grid: { drawOnChartArea: false },
    ticks: { color: COLORES.hum, font: { size: 11 }, callback: (v) => `${v}%` }
  };
  return opciones;
}

function datasetLinea(label, color, unidad, ejeY) {
  const dataset = {
    label, unidad, data: [], borderColor: color, backgroundColor: 'transparent',
    borderWidth: 2, tension: 0.25, spanGaps: true,
    pointRadius: 2, pointBackgroundColor: color, pointBorderWidth: 0,
    pointHoverRadius: 5, pointHoverBackgroundColor: color,
    pointHoverBorderColor: '#0b0f19', pointHoverBorderWidth: 2
  };
  if (ejeY) dataset.yAxisID = ejeY;
  return dataset;
}

function crearGrafica(idCanvas, datasets, opciones) {
  return new Chart(document.getElementById(idCanvas), { type: 'line', data: { datasets }, options: opciones });
}

const chartCo2 = crearGrafica('trendChartCo2',
  [datasetLinea('CO2', COLORES.co2, 'ppm')], opcionesBase());
const chartPm = crearGrafica('trendChartPm',
  [datasetLinea('PM2.5', COLORES.pm25, 'µg/m³'), datasetLinea('PM10', COLORES.pm10, 'µg/m³')], opcionesBase());
const chartAmb = crearGrafica('trendChartAmb',
  [datasetLinea('Temperatura', COLORES.temp, '°C', 'yTemp'), datasetLinea('Humedad', COLORES.hum, '%', 'yHum')],
  opcionesAmbiente());

const historicoChartCo2 = crearGrafica('historicoChartCo2',
  [datasetLinea('CO2', COLORES.co2, 'ppm')], opcionesBase());
const historicoChartPm = crearGrafica('historicoChartPm',
  [datasetLinea('PM2.5', COLORES.pm25, 'µg/m³'), datasetLinea('PM10', COLORES.pm10, 'µg/m³')], opcionesBase());
const historicoChartAmb = crearGrafica('historicoChartAmb',
  [datasetLinea('Temperatura', COLORES.temp, '°C', 'yTemp'), datasetLinea('Humedad', COLORES.hum, '%', 'yHum')],
  opcionesAmbiente());

function asignarSeries(graficas, series, actualizar) {
  const [co2, pm, amb] = graficas;
  co2.data.datasets[0].data = series.co2;
  pm.data.datasets[0].data = series.pm25;
  pm.data.datasets[1].data = series.pm10;
  amb.data.datasets[0].data = series.temp;
  amb.data.datasets[1].data = series.hum;
  graficas.forEach(g => g.update(actualizar));
}

function refrescarVivo() {
  asignarSeries([chartCo2, chartPm, chartAmb], vivo, 'none');
}

function mostrarEnHistorico(series) {
  asignarSeries([historicoChartCo2, historicoChartPm, historicoChartAmb], series);
}

// ---------- Tarjetas ----------
// Pinta la barra de riesgo de una tarjeta; el color lo decide el CSS según data-nivel
function pintarBarra(idBarra, nivel) {
  const barra = document.getElementById(idBarra);
  if (!barra) return;
  if (nivel) {
    barra.dataset.nivel = nivel;
    barra.title = `Riesgo: ${nivel}`;
  } else {
    delete barra.dataset.nivel;
    barra.title = 'Sin datos';
  }
}

// Colorea la tarjeta de riesgo con el color de su nivel y escribe el nivel
function pintarTarjetaRiesgo(idTarjeta, idEtiqueta, nivel, textoSinNivel) {
  const tarjeta = document.getElementById(idTarjeta);
  const etiqueta = document.getElementById(idEtiqueta);
  if (nivel) {
    tarjeta.dataset.nivel = nivel;
    etiqueta.textContent = nivel;
  } else {
    delete tarjeta.dataset.nivel;
    etiqueta.textContent = textoSinNivel;
  }
}

function mostrarValor(clave, valor) {
  const v = VARIABLES[clave];
  document.getElementById(v.tarjeta).innerHTML = `${valor ?? '—'} <span class="unit">${v.unidad}</span>`;
  if (v.barra) pintarBarra(v.barra, nivelDeVariable(clave, valor));
}

function mostrarRiesgo(nivel) {
  pintarTarjetaRiesgo('tarjetaRiesgo', 'riskBadge', nivel, '—');
}

// Solo actualiza lo que el mensaje trae: un mensaje parcial no borra el resto
function actualizarTarjetas(lectura) {
  if (!lectura) return;
  Object.entries(VARIABLES).forEach(([clave, v]) => {
    if (lectura[v.campo] != null) mostrarValor(clave, lectura[v.campo]);
  });
  if (lectura.nivelRiesgo) mostrarRiesgo(lectura.nivelRiesgo);
}

function reiniciarTarjetas() {
  Object.keys(VARIABLES).forEach(clave => mostrarValor(clave, null));
  mostrarRiesgo(null);
}

// ---------- Vista en vivo ----------
function agregarLectura(lectura) {
  if (vistaActual !== 'live') return;
  if (nodoSeleccionado !== 'general' && lectura.nodoId !== nodoSeleccionado) return;

  agregarPuntos(vivo, lectura);
  limitarSeries(vivo);
  refrescarVivo();
  actualizarTarjetas(lectura);
}

// ---------- Alertas (barra lateral) ----------
const MAX_ALERTAS_VISIBLES = 8;
const MAX_ALERTAS_EN_MEMORIA = 30;
const MAX_DESCARTADAS_GUARDADAS = 300;
const CLAVE_DESCARTADAS = 'alertasDescartadas';

const alertasRecientes = [];   // de la más nueva a la más vieja
// Las alertas que el usuario quitó se recuerdan en este navegador; en la base de datos siguen existiendo
const alertasDescartadas = new Set(leerDescartadas());

function leerDescartadas() {
  try {
    const guardadas = JSON.parse(localStorage.getItem(CLAVE_DESCARTADAS) || '[]');
    return Array.isArray(guardadas) ? guardadas : [];
  } catch (e) {
    return [];   // sin almacenamiento disponible: valen solo mientras la página esté abierta
  }
}

function guardarDescartadas() {
  const ids = [...alertasDescartadas].slice(-MAX_DESCARTADAS_GUARDADAS);
  try {
    localStorage.setItem(CLAVE_DESCARTADAS, JSON.stringify(ids));
  } catch (e) {
    // sin almacenamiento: se ignora
  }
}

function colorAlerta(tipo) {
  const t = (tipo || '').toUpperCase();
  if (t.includes('EXTREMADAMENTE')) return RISK_COLORS['EXTREMADAMENTE MALO'];
  if (t.includes('MUY_MALO') || t.includes('CRITICO')) return RISK_COLORS['MUY MALO'];
  if (t.includes('MALO') || t.includes('PELIGRO')) return RISK_COLORS['MALO'];
  return RISK_COLORS['MUY MALO'];
}

function descartarAlerta(id) {
  alertasDescartadas.add(id);
  guardarDescartadas();
  renderizarAlertas();
}

// Se arma con textContent y no con innerHTML: el tipo de alerta viene de mensajes MQTT
function crearElementoAlerta(alerta) {
  const item = document.createElement('div');
  item.className = 'list-item';

  const punto = document.createElement('span');
  punto.className = 'dot';
  punto.style.background = colorAlerta(alerta.tipoAlerta);

  const texto = document.createElement('div');
  texto.className = 'text';
  const titulo = document.createElement('div');
  titulo.className = 'title';
  titulo.textContent = `${alerta.tipoAlerta} — nodo ${(alerta.nodoId || '').toString().slice(0, 8)}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(alerta.timestampOrigen || Date.now()).toLocaleTimeString('es-MX');
  texto.append(titulo, meta);

  item.append(punto, texto);

  if (alerta.id != null) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'btn-descartar';
    boton.textContent = '×';
    boton.title = 'Quitar esta alerta de la lista';
    boton.setAttribute('aria-label', `Quitar la alerta ${alerta.tipoAlerta}`);
    boton.addEventListener('click', () => descartarAlerta(alerta.id));
    item.append(boton);
  }
  return item;
}

function renderizarAlertas() {
  const lista = document.getElementById('alertsList');
  const visibles = alertasRecientes
    .filter(a => !alertasDescartadas.has(a.id))
    .slice(0, MAX_ALERTAS_VISIBLES);

  lista.replaceChildren();
  if (!visibles.length) {
    const vacio = document.createElement('div');
    vacio.className = 'empty';
    vacio.textContent = 'Sin alertas todavía';
    lista.appendChild(vacio);
    return;
  }
  visibles.forEach(a => lista.appendChild(crearElementoAlerta(a)));
}

function agregarAlerta(alerta) {
  if (alerta.id != null && alertasRecientes.some(a => a.id === alerta.id)) return;
  alertasRecientes.unshift(alerta);
  if (alertasRecientes.length > MAX_ALERTAS_EN_MEMORIA) alertasRecientes.pop();
  renderizarAlertas();
}

function cargarAlertasRecientes() {
  fetch('/api/v1/alertas/recientes')
    .then(r => {
      if (!r.ok) throw new Error(`El servidor respondió ${r.status} al pedir las alertas`);
      return r.json();
    })
    .then(alertas => {
      // El API las entrega de la más nueva a la más vieja; se suman a las que ya llegaron por WebSocket
      const conocidas = new Set(alertasRecientes.map(a => a.id));
      alertas.forEach(a => { if (!conocidas.has(a.id)) alertasRecientes.push(a); });
      renderizarAlertas();
    })
    .catch(err => console.error('No se pudieron cargar las alertas recientes:', err));
}

function mostrarVistaViva() {
  vistaActual = 'live';
  document.getElementById('livePanel').style.display = '';
  document.getElementById('historicoPanel').style.display = 'none';
}

function mostrarVistaHistorico() {
  vistaActual = 'historico';
  document.getElementById('livePanel').style.display = 'none';
  document.getElementById('historicoPanel').style.display = '';
  cargarHistoricoConFiltros();
}

function seleccionarNodo(nodoId, etiqueta) {
  mostrarVistaViva();
  nodoSeleccionado = nodoId;
  ['filtroActualCo2', 'filtroActualPm', 'filtroActualAmb'].forEach(id => {
    document.getElementById(id).textContent = etiqueta;
  });

  document.querySelectorAll('#nodesList .list-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.nodoId === nodoId);
  });

  Object.values(vivo).forEach(serie => { serie.length = 0; });
  refrescarVivo();
  reiniciarTarjetas();

  const solicitud = ++contadorSeleccion;
  const url = nodoId === 'general'
    ? `/api/v1/lecturas/historico?horas=${HORAS_VIVO}`
    : `/api/v1/lecturas/historico?nodoId=${nodoId}&horas=${HORAS_VIVO}`;

  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`El servidor respondió ${r.status} al pedir el histórico de este nodo`);
      return r.json();
    })
    .then(datos => {
      if (solicitud !== contadorSeleccion) return;   // el usuario ya cambió de nodo
      datos.forEach(d => agregarPuntos(vivo, d));
      limitarSeries(vivo);
      refrescarVivo();
      datos.forEach(d => actualizarTarjetas(d));     // deja el último valor conocido de cada variable
    })
    .catch(err => console.error('No se pudo cargar el histórico del nodo:', err));
}

function seleccionarHistorico() {
  document.querySelectorAll('#nodesList .list-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.nodoId === 'historico');
  });
  mostrarVistaHistorico();
}

// ---------- Vista de histórico ----------
// Promedio simple de las lecturas recibidas en el periodo (no ponderado por tiempo).
// Se redondea a un decimal y ese mismo número se muestra y se clasifica, para que la barra coincida con lo que se lee.
function mostrarPromedio(clave, valores) {
  const v = VARIABLES[clave];
  const promedio = valores.length
    ? Number((valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(1))
    : null;
  const texto = promedio === null ? '—' : promedio.toFixed(1);
  document.getElementById(v.promedio).innerHTML = `${texto} <span class="unit">${v.unidad}</span>`;
  if (v.barraPromedio) pintarBarra(v.barraPromedio, nivelDeVariable(clave, promedio));
}

function actualizarResumenHistorico(datos) {
  Object.entries(VARIABLES).forEach(([clave, v]) => {
    mostrarPromedio(clave, datos.map(d => d[v.campo]).filter(x => x != null));
  });

  // Peor nivel guardado entre todas las lecturas del periodo (no es el de los promedios)
  const PRIORIDAD_RIESGO = { 'BUENO': 0, 'ACEPTABLE': 1, 'MALO': 2, 'MUY MALO': 3, 'EXTREMADAMENTE MALO': 4 };
  let peorNivel = null;
  datos.forEach(d => {
    if (d.nivelRiesgo && (peorNivel === null || PRIORIDAD_RIESGO[d.nivelRiesgo] > PRIORIDAD_RIESGO[peorNivel])) {
      peorNivel = d.nivelRiesgo;
    }
  });
  pintarTarjetaRiesgo('tarjetaRiesgoHist', 'histRiskBadge', peorNivel, 'Sin datos');
}

function cargarHistoricoConFiltros() {
  const ubicacion = document.getElementById('filtroUbicacion').value;
  const periodo = document.getElementById('filtroPeriodo').value;
  const params = new URLSearchParams();
  if (ubicacion !== 'general') params.set('nodoId', ubicacion);

  if (periodo === 'personalizado') {
    const desde = document.getElementById('fechaDesde').value;
    const hasta = document.getElementById('fechaHasta').value;
    if (!desde || !hasta) return;
    params.set('desde', desde);
    params.set('hasta', hasta);
  } else {
    const horasPorPeriodo = { '24h': 24, 'semana': 168, 'mes': 720 };
    params.set('horas', horasPorPeriodo[periodo] || 24);
  }

  const solicitud = ++contadorHistorico;
  fetch(`/api/v1/lecturas/historico?${params.toString()}`)
    .then(r => {
      if (!r.ok) throw new Error(`El servidor respondió ${r.status} al pedir el histórico`);
      return r.json();
    })
    .then(datos => {
      if (solicitud !== contadorHistorico) return;   // llegó una consulta más reciente
      mostrarEnHistorico(aSeries(datos));
      actualizarResumenHistorico(datos);
    })
    .catch(err => console.error('No se pudo cargar el histórico:', err));
}

function configurarLimitesFecha() {
  fetch('/api/v1/lecturas/primera')
    .then(r => r.json())
    .then(datos => {
      const hoy = new Date().toISOString().split('T')[0];
      const desdeInput = document.getElementById('fechaDesde');
      const hastaInput = document.getElementById('fechaHasta');
      hastaInput.max = hoy;
      desdeInput.max = hoy;
      if (datos.timestampOrigen) {
        const minFecha = datos.timestampOrigen.split('T')[0];
        desdeInput.min = minFecha;
        hastaInput.min = minFecha;
      }
    })
    .catch(() => {});
}

function clamparFecha(input) {
  if (input.min && input.value < input.min) input.value = input.min;
  if (input.max && input.value > input.max) input.value = input.max;
}

document.getElementById('filtroPeriodo').addEventListener('change', (e) => {
  const esPersonalizado = e.target.value === 'personalizado';
  document.getElementById('campoDesde').style.display = esPersonalizado ? '' : 'none';
  document.getElementById('campoHasta').style.display = esPersonalizado ? '' : 'none';
  if (esPersonalizado) configurarLimitesFecha();
  else cargarHistoricoConFiltros();
});
document.getElementById('filtroUbicacion').addEventListener('change', cargarHistoricoConFiltros);

document.getElementById('fechaDesde').addEventListener('change', (e) => {
  clamparFecha(e.target);
  const hastaInput = document.getElementById('fechaHasta');
  hastaInput.min = e.target.value;
  if (hastaInput.value && hastaInput.value < e.target.value) hastaInput.value = e.target.value;
  cargarHistoricoConFiltros();
});

document.getElementById('fechaHasta').addEventListener('change', (e) => {
  clamparFecha(e.target);
  const desdeInput = document.getElementById('fechaDesde');
  if (desdeInput.value && e.target.value < desdeInput.value) e.target.value = desdeInput.value;
  cargarHistoricoConFiltros();
});

// ---------- Recuadro "Saber más" ----------
document.getElementById('btnSaberMas').addEventListener('click', () => {
  const breve = document.getElementById('infoBreve');
  const detalle = document.getElementById('infoDetalle');
  const boton = document.getElementById('btnSaberMas');
  const expandido = detalle.style.display !== 'none';

  breve.style.display = expandido ? '' : 'none';
  detalle.style.display = expandido ? 'none' : '';
  boton.textContent = expandido ? 'Saber más' : 'Ver menos';
});

// ---------- Conexión y nodos ----------
function conectar() {
  const socket = new SockJS('/ws-calidad-aire');
  const stompClient = Stomp.over(socket);
  stompClient.debug = null;
  stompClient.connect({}, () => {
    document.getElementById('connDot').classList.remove('offline');
    document.getElementById('connLabel').textContent = 'Conectado';
    stompClient.subscribe('/topic/lecturas', (msg) => agregarLectura(JSON.parse(msg.body)));
    stompClient.subscribe('/topic/alertas', (msg) => agregarAlerta(JSON.parse(msg.body)));
  }, () => {
    document.getElementById('connDot').classList.add('offline');
    document.getElementById('connLabel').textContent = 'Desconectado — reintentando…';
    setTimeout(conectar, 3000);
  });
}

function cargarNodos() {
  fetch('/api/v1/nodos')
    .then(r => r.json())
    .then(nodos => {
      const list = document.getElementById('nodesList');
      list.innerHTML = '';

      const general = document.createElement('div');
      general.className = 'list-item clickable selected';
      general.dataset.nodoId = 'general';
      general.innerHTML = `<span class="dot" style="background:var(--accent)"></span><div class="text"><div class="title">General</div><div class="meta">Todos los nodos</div></div>`;
      general.addEventListener('click', () => seleccionarNodo('general', 'general'));
      list.appendChild(general);

      const historico = document.createElement('div');
      historico.className = 'list-item clickable separator';
      historico.dataset.nodoId = 'historico';
      historico.innerHTML = `<span class="dot" style="background:var(--text-secondary)"></span><div class="text"><div class="title">Histórico</div><div class="meta">Consultar por rango de fechas</div></div>`;
      historico.addEventListener('click', seleccionarHistorico);
      list.appendChild(historico);

      const selectUbicacion = document.getElementById('filtroUbicacion');
      selectUbicacion.innerHTML = '<option value="general">Todos</option>';

      nodos.forEach(n => {
        const item = document.createElement('div');
        item.className = 'list-item clickable';
        item.dataset.nodoId = n.id;
        item.innerHTML = `<span class="dot" style="background:${n.estatus ? '#22c55e' : '#ef4444'}"></span><div class="text"><div class="title">${n.ubicacion || 'Sin asignar'}</div><div class="meta">${n.id.toString().slice(0, 8)}</div></div>`;
        item.addEventListener('click', () => seleccionarNodo(n.id, n.ubicacion || n.id.toString().slice(0, 8)));
        list.appendChild(item);

        const opcion = document.createElement('option');
        opcion.value = n.id;
        opcion.textContent = n.ubicacion || n.id.toString().slice(0, 8);
        selectUbicacion.appendChild(opcion);
      });
    })
    .catch(() => { document.getElementById('nodesList').innerHTML = '<div class="empty">No se pudo cargar</div>'; });
}

conectar();
cargarNodos();
cargarAlertasRecientes();
seleccionarNodo('general', 'general');