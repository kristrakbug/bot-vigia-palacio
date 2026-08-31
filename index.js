const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
require('dotenv').config(); 

// ==============================================================================
// 1. CONFIGURACIÓN PRINCIPAL
// ==============================================================================
const URL_WEXAIT = "https://wexait.com/api/v1/actualizar-inventario-secreto";
const TOKEN_SECRETO = "WexaitBot2026_Admin";

const URL_LOGIN_MAYORISTAS = "https://mayoristasstreaming.com/login";

const CORREO_PROVEEDOR = process.env.PROVEEDOR2_EMAIL;
const CONTRASENA_PROVEEDOR = process.env.PROVEEDOR2_PASSWORD;

async function obtenerProductosDesdeWexait() {
    try {
        console.log("\n[*] Consultando a Wexait la lista de productos de MAYORISTAS actualizada...");
        const res = await axios.get("https://wexait.com/api/lista-vigilancia-mayoristas");
        
        if (res.data && res.data.length > 0) {
            console.log(`✅ Wexait devolvió ${res.data.length} productos para vigilar en Mayoristas.`);
            return res.data;
        }
    } catch (error) {
        console.log("[!] Error obteniendo la lista de Wexait. Asegúrate de que la ruta exista.");
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
            const accion = hay_stock ? `🟢 DISPONIBLE (Stock leído: ${cantidad_stock})` : "🔴 AGOTADO (OFF)";
            console.log(`[*] Wexait sincronizado: ${nombre_referencia} -> ${accion}`);
        }
    } catch (error) {
        console.log(`[!] Error de conexión con la API de Wexait para el producto ID ${producto_id}`);
    }
}

// ==============================================================================
// 2. MOTOR DE SCRAPING 
// ==============================================================================
async function verificarStockProveedor() {
    const PRODUCTOS_A_VIGILAR = await obtenerProductosDesdeWexait();
    
    if (PRODUCTOS_A_VIGILAR.length === 0) {
        console.log("⚠️ No hay productos con enlace de Mayoristas en tu panel de Wexait. Saltando ciclo...");
        return; 
    }

    console.log("\n[+] Iniciando inspección de inventario con Puppeteer Stealth Avanzado...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--disable-features=site-per-process',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(60000); 

        await page.setViewport({ width: 1366, height: 768 });
        // User Agent ultra estándar para no levantar sospechas
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        });

        // --- 1. LOGIN (CON BYPASS DE CLOUDFLARE) ---
        try {
            console.log("[*] Entrando a Mayoristas Streaming...");
            // Usamos 'domcontentloaded' para que Puppeteer no se quede trabado si Cloudflare hace redirecciones infinitas
            await page.goto(URL_LOGIN_MAYORISTAS, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            console.log("[*] Resolviendo posible barrera de Cloudflare...");

            // TÁCTICA ANTI-CLOUDFLARE: Movimientos de ratón simulados. 
            // Turnstile (la verificación) a menudo se autocompleta si detecta "ruido humano".
            for (let i = 0; i < 12; i++) {
                await page.mouse.move(Math.random() * 800, Math.random() * 600);
                await new Promise(r => setTimeout(r, Math.random() * 400 + 200));
            }

            // Damos hasta 45 segundos para que la página de Cloudflare haga la transición automática al login
            const selectorEmail = 'input[data-key="user_email"]';
            await page.waitForSelector(selectorEmail, { timeout: 45000 });
            console.log("[*] ¡Barrera superada! Formulario detectado.");

            if (!CORREO_PROVEEDOR || !CONTRASENA_PROVEEDOR) {
                throw new Error("Las variables PROVEEDOR2_EMAIL o PROVEEDOR2_PASSWORD están vacías.");
            }

            // Tipeo simulando pulsaciones humanas
            await page.type(selectorEmail, CORREO_PROVEEDOR, { delay: 65 });
            await new Promise(r => setTimeout(r, 800));
            await page.type('input[data-key="user_password"]', CONTRASENA_PROVEEDOR, { delay: 70 });
            
            await new Promise(r => setTimeout(r, 1000));

            await Promise.all([
                page.evaluate(() => {
                    const btnAcceder = document.querySelector('#um-submit-btn');
                    if (btnAcceder) btnAcceder.click();
                }),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
            ]);
            console.log("✅ Sesión iniciada con éxito.");
        } catch (err) {
            console.log(`[!] Error crítico en el LOGIN (Posible bloqueo permanente de Cloudflare): ${err.message}`);
        }

        // --- 2. NAVEGAR Y VERIFICAR CADA PRODUCTO ---
        for (const prod of PRODUCTOS_A_VIGILAR) {
            console.log(`\n🚀 Iniciando MISIÓN DE VIGILANCIA para: ${prod.nombre}`);
            try {
                await page.goto(prod.url_proveedor, { waitUntil: 'domcontentloaded', timeout: 60000 });
                console.log("✅ Producto cargado.");
                
                await new Promise(r => setTimeout(r, 4000)); 

                const resultadoScraping = await page.evaluate(() => {
                    let numeroStock = 0;
                    
                    const stockElement = document.querySelector('.product-stock .stock') || document.querySelector('.stock.in-stock');
                    if (stockElement && stockElement.innerText) {
                        const match = stockElement.innerText.match(/\d+/);
                        if (match) {
                            numeroStock = parseInt(match[0], 10);
                        }
                    }

                    const addBtn = document.querySelector('.single_add_to_cart_button, button[name="add-to-cart"], .add_to_cart_button');
                    const outOfStockLabel = document.querySelector('.out-of-stock');
                    
                    let estado = 'agotado'; 

                    if (numeroStock > 0) {
                        estado = 'disponible';
                    } 
                    else if (addBtn && !addBtn.disabled && !outOfStockLabel) {
                        estado = 'disponible';
                        numeroStock = 99;
                    }

                    return { estado, stockLeido: numeroStock };
                });

                const hayStock = (resultadoScraping.estado === 'disponible');
                console.log(`[🔍] Diagnóstico: Estado = ${resultadoScraping.estado.toUpperCase()}, Stock leído = ${resultadoScraping.stockLeido}`);

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
            console.log("[*] Navegador cerrado para mantener el servidor optimizado.");
        }
    }
}

// ==============================================================================
// 3. BUCLE DE TIEMPO EXACTO (RELOJ SUIZO)
// ==============================================================================
function obtenerHoraColombia() {
    const ahora = new Date();
    const opciones = { timeZone: 'America/Bogota', hour: 'numeric', hour12: false };
    const formateador = new Intl.DateTimeFormat('en-US', opciones);
    return parseInt(formateador.format(ahora), 10);
}

async function iniciarVigilancia() {
    console.log("=======================================================");
    console.log("🚀 BOT VIGÍA (MAYORISTAS STREAMING) INICIADO");
    console.log("=======================================================");

    const horaInicio = obtenerHoraColombia();
    if (horaInicio >= 8 && horaInicio < 22) {
        await verificarStockProveedor();
    } else {
        console.log("[Noche COP] Bot iniciado de noche. Reposando hasta las 8 AM.");
    }

    while (true) {
        const ahora = new Date();
        const minutos = ahora.getMinutes();
        const segundos = ahora.getSeconds();
        const milisegundos = ahora.getMilliseconds();

        let minutosParaEsperar = 0;
        if (minutos < 30) {
            minutosParaEsperar = 30 - minutos;
        } else {
            minutosParaEsperar = 60 - minutos;
        }

        const msParaEsperar = (minutosParaEsperar * 60 * 1000) - (segundos * 1000) - milisegundos;
        const proximoEscaneo = new Date(ahora.getTime() + msParaEsperar);
        const formateadorHora = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true });
        
        console.log(`\n[*] Pausa activada. Esperando hasta las ${formateadorHora.format(proximoEscaneo)} para el siguiente ciclo...`);
        
        await new Promise(r => setTimeout(r, msParaEsperar)); 
        
        const horaActual = obtenerHoraColombia();
        
        if (horaActual >= 8 && horaActual < 22) {
            await verificarStockProveedor();
        } else {
            console.log("[Noche COP] Horario inactivo (10 PM - 8 AM). Bot en reposo.");
        }
    }
}

iniciarVigilancia();
