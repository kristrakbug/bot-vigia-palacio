const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');

// ==============================================================================
// 1. CONFIGURACIÓN PRINCIPAL (PALACIO DIGITAL - GITHUB ACTIONS)
// ==============================================================================
const URL_WEXAIT = "https://wexait.com/api/v1/actualizar-inventario-secreto";
const TOKEN_SECRETO = process.env.TOKEN_SECRETO;

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
// 2. MOTOR DE SCRAPING 
// ==============================================================================
async function verificarStockProveedor() {
    if (!CORREO_PROVEEDOR || !CONTRASENA_PROVEEDOR || !TOKEN_SECRETO) {
        console.error("❌ Faltan las variables de entorno (Secrets) en GitHub.");
        process.exit(1);
    }

    const PRODUCTOS_A_VIGILAR = await obtenerProductosDesdeWexait();
    
    if (PRODUCTOS_A_VIGILAR.length === 0) {
        console.log("⚠️ No hay productos para vigilar. Cerrando...");
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
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
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
            console.log(`🔗 URL Visitada: ${prod.url_proveedor}`); 
            
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
                    let textoExtraido = 'No se encontró el texto';

                    const stockElement = document.querySelector('.product-stock .stock');
                    
                    if (stockElement && stockElement.innerText) {
                        textoExtraido = stockElement.innerText.trim();
                        const match = textoExtraido.match(/\d+/);
                        if (match) {
                            numeroStock = parseInt(match[0], 10);
                            if (numeroStock > 0) estado = 'disponible';
                        }
                    } else {
                        const parentElement = document.querySelector('.product-stock');
                        if (parentElement && parentElement.innerText) {
                            textoExtraido = parentElement.innerText.trim();
                            const match = textoExtraido.match(/\d+/);
                            if (match) {
                                numeroStock = parseInt(match[0], 10);
                                if (numeroStock > 0) estado = 'disponible';
                            }
                        }
                    }

                    const addBtn = document.querySelector('button[name="add-to-cart"], .single_add_to_cart_button');
                    if (estado === 'agotado' && addBtn && addBtn.offsetWidth > 0 && addBtn.offsetHeight > 0) {
                        estado = 'disponible';
                        numeroStock = 99; 
                    }

                    return { estado, stockLeido: numeroStock, textoHTML: textoExtraido };
                });

                const hayStock = (resultadoScraping.estado === 'disponible');
                
                console.log(`[🕵️‍♂️] Texto capturado por el bot: "${resultadoScraping.textoHTML}"`);
                console.log(`[🔍] Diagnóstico: ${resultadoScraping.estado.toUpperCase()} | Stock Leído: ${resultadoScraping.stockLeido}`);

                await actualizarProductoWexait(prod.id_wexait, hayStock, resultadoScraping.stockLeido, prod.nombre);

            } catch (error) {
                console.log(`[!] Error al inspeccionar ${prod.nombre}: ${error.message}`);
            }
            
            await new Promise(r => setTimeout(r, 2500));
        }

    } catch (error) {
        console.error("❌ Error General de Puppeteer:", error.message);
        process.exit(1);
    } finally {
        if (browser) {
            try {
                const pages = await browser.pages();
                for (const p of pages) {
                    await p.close().catch(() => {});
                }
                const childProcess = browser.process();
                if (childProcess) {
                    childProcess.kill('SIGKILL');
                }
                await browser.close().catch(() => {});
            } catch (e) {}
            console.log("[*] Navegador limpiado. Ciclo finalizado.");
        }
    }
}

// ==============================================================================
// 3. EJECUCIÓN ÚNICA PARA GITHUB ACTIONS
// ==============================================================================
async function iniciarVigilancia() {
    console.log("=======================================================");
    console.log("🚀 BOT VIGÍA (PALACIO DIGITAL) INICIADO EN GITHUB ACTIONS");
    console.log("=======================================================");

    await verificarStockProveedor();

    console.log("=======================================================");
    console.log("🏁 Escaneo completado. Apagando contenedor.");
    console.log("=======================================================");
    process.exit(0);
}

iniciarVigilancia();
