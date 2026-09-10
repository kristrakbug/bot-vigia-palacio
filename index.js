const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
require('dotenv').config(); 

// ==============================================================================
// 1. CONFIGURACIÓN PRINCIPAL (PALACIO DIGITAL)
// ==============================================================================
const URL_WEXAIT = "https://wexait.com/api/v1/actualizar-inventario-secreto";
const TOKEN_SECRETO = "WexaitBot2026_Admin";

const URL_LOGIN_PALACIO = "https://palaciodigital.net/login/";

const CORREO_PROVEEDOR = process.env.PALACIO_EMAIL;
const CONTRASENA_PROVEEDOR = process.env.PALACIO_PASSWORD;

async function obtenerProductosDesdeWexait() {
    try {
        console.log("\n[*] Consultando a Wexait la lista de productos de PALACIO DIGITAL...");
        const res = await axios.get("https://wexait.com/api/lista-vigilancia-palacio"); 
        
        if (res.data && res.data.length > 0) {
            console.log(`✅ Wexait devolvió ${res.data.length} productos para vigilar.`);
            return res.data;
        }
    } catch (error) {
        console.log("[!] Error obteniendo la lista de Wexait. Verifica la ruta.");
    }
    return [];
}

async function actualizarProductoWexait(producto_id, hay_stock, cantidad_stock, nombre_referencia) {
    const estado_api = hay_stock ? 1 : 0;
    try {
        const params = new URLSearchParams();
        params.append('id', producto_id);
        params.append('status', estado_api);
        params.append('stock', cantidad_stock); 
        params.append('token', TOKEN_SECRETO);

        const res = await axios.post(URL_WEXAIT, params);
        if (res.status === 200) {
            const accion = hay_stock ? `🟢 DISPONIBLE (Stock: ${cantidad_stock})` : "🔴 AGOTADO (OFF)";
            console.log(`[*] Wexait sincronizado: ${nombre_referencia} -> ${accion}`);
        }
    } catch (error) {
        console.log(`[!] Error de conexión con la API de Wexait para el producto ID ${producto_id}`);
    }
}

// ==============================================================================
// 2. MOTOR DE SCRAPING (EXTRACCIÓN EXACTA DE STOCK)
// ==============================================================================
async function verificarStockProveedor() {
    const PRODUCTOS_A_VIGILAR = await obtenerProductosDesdeWexait();
    
    if (PRODUCTOS_A_VIGILAR.length === 0) {
        console.log("⚠️ No hay productos para vigilar. Saltando ciclo...");
        return; 
    }

    console.log("\n[+] Iniciando inspección de inventario en Palacio Digital...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        const page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(60000); 

        // --- 1. LOGIN ---
        try {
            console.log("[*] Entrando a Palacio Digital...");
            await page.goto(URL_LOGIN_PALACIO, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            await page.waitForSelector('input[data-key="username"]', { visible: true, timeout: 15000 });

            await page.type('input[data-key="username"]', CORREO_PROVEEDOR, { delay: 65 });
            await page.type('input[data-key="user_password"]', CONTRASENA_PROVEEDOR, { delay: 70 });
            
            await Promise.all([
                page.evaluate(() => {
                    const btnAcceder = document.querySelector('button[name="login"]') || document.querySelector('#um-submit-btn') || document.querySelector('input[type="submit"]');
                    if (btnAcceder) btnAcceder.click();
                }),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
            ]);
            console.log("✅ Sesión iniciada con éxito.");
        } catch (err) {
            console.log(`[!] Error crítico en el LOGIN: ${err.message}`);
            return;
        }

        // --- 2. NAVEGAR Y EXTRAER STOCK EXACTO ---
        for (const prod of PRODUCTOS_A_VIGILAR) {
            console.log(`\n🚀 Revisando stock de: ${prod.nombre}`);
            try {
                await page.goto(prod.url_proveedor, { waitUntil: 'networkidle2', timeout: 60000 });
                
                try {
                    await page.waitForSelector('.product-stock, div.product', { visible: true, timeout: 15000 });
                } catch (e) {
                    console.log("⚠️ La página tardó un poco, verificando DOM directamente...");
                }

                const resultadoScraping = await page.evaluate(() => {
                    let estado = 'agotado'; 
                    let numeroStock = 0;

                    // 1. Buscamos el texto exacto
                    const stockElement = document.querySelector('.product-stock .stock') || document.querySelector('.stock');
                    
                    if (stockElement && stockElement.innerText) {
                        const match = stockElement.innerText.match(/\d+/);
                        if (match) {
                            numeroStock = parseInt(match[0], 10);
                            if (numeroStock > 0) estado = 'disponible';
                        }
                    }

                    // 2. Respaldo por si ocultan el número pero el botón de compra está activo
                    const addBtn = document.querySelector('button[name="add-to-cart"], .single_add_to_cart_button');
                    if (estado === 'agotado' && addBtn && addBtn.offsetWidth > 0 && addBtn.offsetHeight > 0) {
                        estado = 'disponible';
                        numeroStock = 99; 
                    }

                    return { estado, stockLeido: numeroStock };
                });

                const hayStock = (resultadoScraping.estado === 'disponible');
                console.log(`[🔍] Diagnóstico: ${resultadoScraping.estado.toUpperCase()} | Stock Leído: ${resultadoScraping.stockLeido}`);

                await actualizarProductoWexait(prod.id_wexait, hayStock, resultadoScraping.stockLeido, prod.nombre);

            } catch (error) {
                console.log(`[!] Error al inspeccionar ${prod.nombre}: ${error.message}`);
            }
            
            await new Promise(r => setTimeout(r, 2500));
        }

    } catch (error) {
        console.error("❌ Error General de Puppeteer:", error.message);
    } finally {
        if (browser) {
            await browser.close();
            console.log("[*] Navegador cerrado. Ciclo finalizado.");
        }
    }
}

// ==============================================================================
// 3. BUCLE DE TIEMPO
// ==============================================================================
function obtenerHoraColombia() {
    const ahora = new Date();
    const opciones = { timeZone: 'America/Bogota', hour: 'numeric', hour12: false };
    const formateador = new Intl.DateTimeFormat('en-US', opciones);
    return parseInt(formateador.format(ahora), 10);
}

async function iniciarVigilancia() {
    console.log("=======================================================");
    console.log("🚀 BOT VIGÍA (PALACIO DIGITAL) INICIADO EN SEGUNDO PLANO");
    console.log("=======================================================");

    const horaInicio = obtenerHoraColombia();
    if (horaInicio >= 8 && horaInicio < 22) {
        await verificarStockProveedor();
    } else {
        console.log("[Noche COP] Bot iniciado de noche. Reposando hasta las 8 AM.");
    }

    while (true) {
        const msParaEsperar = 45 * 60 * 1000; 
        
        const ahora = new Date();
        const proximoEscaneo = new Date(ahora.getTime() + msParaEsperar);
        const formateadorHora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true });
        
        console.log(`\n[*] Pausa de 45 minutos activada. Siguiente ciclo a las ${formateadorHora.format(proximoEscaneo)}...`);
        
        await new Promise(r => setTimeout(r, msParaEsperar)); 
        
        const horaActual = obtenerHoraColombia();
        
        if (horaActual >= 8 && horaActual < 22) {
            await verificarStockProveedor();
        } else {
            console.log("[Noche COP] Horario inactivo (10 PM - 8 AM). El bot pasará este ciclo en reposo.");
        }
    }
}

iniciarVigilancia();
