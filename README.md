# BANVA — Sistema de Factura a Etiquetas

App web que convierte fotos de facturas en etiquetas con código de barras listas para imprimir.

## Cómo subir a Vercel (5 minutos)
 
### Paso 1: Crear cuenta en Vercel
1. Ve a **https://vercel.com**
2. Haz clic en **Sign Up**
3. Elige **Continue with GitHub** (o con email)

### Paso 2: Subir el proyecto
1. Ve a **https://vercel.com/new**
2. En la sección de abajo busca **"Import Third-Party Git Repository"** → O mejor:
3. Haz clic en **"Upload"** (arrastra la carpeta `banva-etiquetas` completa)
4. Vercel detectará que es un sitio estático
5. Haz clic en **Deploy**

### Paso 3: Listo
- Vercel te dará una URL tipo: `banva-etiquetas.vercel.app`
- Esa URL funciona en celular y computador
- Desde Chrome puedes "Instalar" la app (aparece como ícono en el escritorio)

### Alternativa: Deploy con CLI
```bash
# Instalar Vercel CLI
npm i -g vercel

# Desde la carpeta del proyecto
cd banva-etiquetas
vercel

# Seguir las instrucciones en pantalla
```

## Cómo instalar como app en el celular
1. Abre la URL en Chrome
2. Toca los 3 puntos (⋮) arriba a la derecha
3. Selecciona **"Instalar app"** o **"Agregar a pantalla de inicio"**
4. Se crea un ícono en tu escritorio como cualquier app

## Cómo instalar como app en el computador
1. Abre la URL en Chrome
2. En la barra de dirección aparece un ícono de instalación (⊕)
3. Haz clic → "Instalar"
4. Se abre como ventana independiente

## Estructura del proyecto
```
banva-etiquetas/
├── index.html      ← La app completa (React + estilos + lógica)
├── manifest.json   ← Configuración PWA
├── sw.js           ← Service Worker (offline)
├── icon-192.png    ← Ícono 192x192
├── icon-512.png    ← Ícono 512x512
├── vercel.json     ← Config de Vercel
└── README.md       ← Este archivo
```

## Notas
- El diccionario SKU↔Código ML se guarda en el navegador (localStorage)
- Solo hay que cargarlo una vez, queda guardado
- La app usa la API de Anthropic (Claude) para leer las facturas
- Funciona en celular y computador
