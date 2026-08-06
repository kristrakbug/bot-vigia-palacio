const puppeteer = require('puppeteer');
const axios = require('axios');
require('dotenv').config(); 

// ==============================================================================
// 1. CONFIGURACIÓN PRINCIPAL
// ==============================================================================
const URL_WEXAIT = "https://wexait.com/api/v1/actualizar-inventario-secreto";
const TOKEN_SECRETO = "WexaitBot2026_Admin";

const URL_LOGIN_MAYORISTAS = "https://mayoristasstreaming.com/login";

// Tomará los datos de las Variables de Entorno en Railway
const CORREO_PROVEEDOR = process.env.PROVEEDOR2_EMAIL;
const CONTRASENA_PROVEEDOR = process.env.PROVEEDOR2_PASSWORD;

// ⚠️ LISTA DE PRODUCTOS DE MAYORISTAS A VIGILAR ⚠️
// Solo dejé uno de ejemplo. ¡Debes agregar los demás con sus IDs reales de Wexait y URLs!
const PRODUCTOS_A_VIGILAR = [
    {
        id_wexait: 10, // ID del producto en tu tienda Wexait
        nombre: "PLEX PANTALLA (premium)",
        url_proveedor: "https://mayoristasstreaming.com/product/plex-pantalla-premium/"
    },
    // Añade el resto de tu catálogo de Mayoristas aquí siguiendo la misma estructura...
];

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
    console.log("\n[+] Iniciando inspección de inventario en Mayoristas con Puppeteer...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process'
            ]
        });
        const page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(60000); 

        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

        // --- 1. LOGIN ---
        try {
            console.log("[*] Entrando a Mayoristas Streaming...");
            await page.goto(URL_LOGIN_MAYORISTAS, { waitUntil: 'networkidle2', timeout: 60000 });
            
            await page.type('input[data-key="user_email"]', CORREO_PROVEEDOR);
            await page.type('input[data-key="user_password"]', CONTRASENA_PROVEEDOR);
            
            await Promise.all([
                page.evaluate(() => {
                    const btnAcceder = document.querySelector('#um-submit-btn');
                    if (btnAcceder) btnAcceder.click();
                }),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
            ]);
            console.log("✅ Sesión iniciada.");
        } catch (err) {
            console.log("[?] Omitiendo login (es posible que ya esté logueado o cargó muy rápido).");
        }

        // --- 2. NAVEGAR Y VERIFICAR CADA PRODUCTO ---
        for (const prod of PRODUCTOS_A_VIGILAR) {
            console.log(`\n🚀 Iniciando MISIÓN DE VIGILANCIA para: ${prod.nombre}`);
            try {
                await page.goto(prod.url_proveedor, { waitUntil: 'networkidle2', timeout: 60000 });
                console.log("✅ Producto cargado.");
                
                await new Promise(r => setTimeout(r, 4000)); // Damos tiempo a que renderice el botón

                const resultadoScraping = await page.evaluate(() => {
                    // Lógica segura de WooCommerce
                    const addBtn = document.querySelector('.single_add_to_cart_button, button[name="add-to-cart"], .add_to_cart_button');
                    const outOfStockLabel = document.querySelector('.out-of-stock');
                    
                    let estado = 'disponible';
                    if (!addBtn || addBtn.disabled || outOfStockLabel) {
                        estado = 'agotado';
                    }

                    // Extraer cantidad de stock de la etiqueta de WooCommerce
                    let numeroStock = 0;
                    const stockElement = document.querySelector('.stock.in-stock');
                    if (stockElement) {
                        const match = stockElement.innerText.match(/\d+/);
                        if (match) {
                            numeroStock = parseInt(match[0], 10);
                        }
                    } else if (estado === 'disponible') {
                        // Si está disponible pero el proveedor no muestra el número exacto, ponemos 99 por defecto
                        numeroStock = 99;
                    }

                    return { estado, stockLeido: numeroStock };
                });

                const hayStock = (resultadoScraping.estado === 'disponible');
                console.log(`[🔍] Diagnóstico: Estado = ${resultadoScraping.estado.toUpperCase()}, Stock leído = ${resultadoScraping.stockLeido}`);

                // Enviamos los datos a la API de Wexait
                await actualizarProductoWexait(prod.id_wexait, hayStock, resultadoScraping.stockLeido, prod.nombre);

            } catch (error) {
                console.log(`[!] Error al inspeccionar ${prod.nombre}: ${error.message}`);
            }
            
            // Pausa entre productos para no saturar al proveedor
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
    console.log("🚀 BOT VIGÍA (MAYORISTAS STREAMING) INICIADO");
    console.log("=======================================================");

    // Ejecución inmediata al arrancar el bot en Railway
    await verificarStockProveedor();
    console.log("[*] Escaneo inicial completado. Iniciando bucle...");

    while (true) {
        const horaActual = obtenerHoraColombia();
        
        if (horaActual >= 8) {
            await new Promise(r => setTimeout(r, 2700000)); // Espera 45 minutos antes del siguiente
            await verificarStockProveedor();
            console.log("[*] Misión terminada. Esperando 45 minutos para el siguiente escaneo...");
        } else {
            console.log("[Noche COP] Horario inactivo. Bot en reposo nocturno (12 AM - 8 AM).");
            await new Promise(r => setTimeout(r, 900000)); 
        }
    }
}

// Arranque de la máquina
iniciarVigilancia();
