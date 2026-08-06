const puppeteer = require('puppeteer');
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
                
                await new Promise(r => setTimeout(r, 4000)); 

                const resultadoScraping = await page.evaluate(() => {
                    const addBtn = document.querySelector('.single_add_to_cart_button, button[name="add-to-cart"], .add_to_cart_button');
                    const outOfStockLabel = document.querySelector('.out-of-stock');
                    
                    let estado = 'disponible';
                    if (!addBtn || addBtn.disabled || outOfStockLabel) {
                        estado = 'agotado';
                    }

                    // 🔥 LÓGICA DE EXTRACCIÓN DE NÚMERO MEJORADA PARA MAYORISTAS 🔥
                    let numeroStock = 0;
                    // Buscamos específicamente el span con clase 'stock' que está dentro de 'product-stock'
                    const stockElement = document.querySelector('.product-stock .stock') || document.querySelector('.stock.in-stock');
                    
                    if (stockElement && stockElement.innerText) {
                        const match = stockElement.innerText.match(/\d+/);
                        if (match) {
                            numeroStock = parseInt(match[0], 10);
                        }
                    } else if (estado === 'disponible') {
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

    while (true) {
        const horaActual = obtenerHoraColombia();
        
        // 🔥 Trabaja si es mayor/igual a 8 AM Y menor a las 10 PM (22) 🔥
        if (horaActual >= 8 && horaActual < 22) {
            // 1. Ejecuta la revisión
            await verificarStockProveedor();
            
            // 2. Avisa que ha terminado
            console.log("[*] Misión terminada. Esperando 45 minutos para el siguiente escaneo...\n");
            
            // 3. Hace la pausa (2700000 ms)
            await new Promise(r => setTimeout(r, 2700000)); 
        } else {
            // Mensaje nocturno actualizado
            console.log("[Noche COP] Horario inactivo (10 PM - 8 AM). Bot en reposo. Vuelve a las 8 AM a volver a revisar.");
            await new Promise(r => setTimeout(r, 900000)); // Revisa cada 15 min si ya son las 8
        }
    }
}

iniciarVigilancia();
