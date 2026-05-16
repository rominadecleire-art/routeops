# ROUTEOPS — Estado del Proyecto

## Stack Tecnológico

- **Backend:** Flask (Python)
- **Frontend:** HTML / CSS / JavaScript (vanilla)
- **Base de datos:** SQLite para geocaché de coordenadas
- **Ruteo:** OSRM (Open Source Routing Machine)
- **IA — PDFs y fotos:** Claude Vision (Anthropic)
- **IA — Audio iOS:** OpenAI Whisper

## Deploy

- **URL producción:** https://routeops-auxi.onrender.com
- **Repositorio:** https://github.com/rominadecleire-art/routeops
- **Subir cambios:** doble click en `deploy.bat`

## IDs importantes en index.html

| ID | Descripción |
|----|-------------|
| `mpanel-pdf` | Panel de carga de PDF |
| `mpanel-image` | Panel de carga de imagen/foto |
| `mpanel-audio` | Panel de carga de audio |
| `mpanel-text` | Panel de ingreso de texto |
| `extract-city-inp` | Input de ciudad para el panel PDF |
| `extract-city-inp-img` | Input de ciudad para el panel imagen |

## Bugs Pendientes

### ~~1. switchMethod en app.js usa IDs incorrectos~~ ✓ RESUELTO (commit c25fa33)
El código referenciaba `extract-city-wrap` (ID inexistente). Corregido embebiendo el input ciudad directamente en `mpanel-pdf` y `mpanel-image`. `switchMethod` ya solo maneja tabs y paneles con IDs correctos.

### ~~2. Agrupación por código postal de 4 dígitos no funciona~~ ✓ RESUELTO
`extractPostalCode` usaba regex `/\b(\d{4})\b/` que fallaba con el formato "CP2627" (sin espacio entre "CP" y los dígitos, no hay word boundary entre "P" y "2"). Corregido a `/\bCP\s*(\d{4})\b|\b(\d{4})\b/i` para manejar ambos formatos.

### ~~3. Ciudad única sin agrupación cuando todas las paradas están a menos de 20 km~~ ✓ RESUELTO
`isSingleCity` usaba umbral del 70%, permitiendo que hasta el 30% de las paradas quedaran fuera del radio sin activar multi-ciudad. Cambiado a `best >= n` (100%): ahora solo es ciudad única si TODAS las paradas están dentro de 20km del punto más denso.

### ~~4. Horario límite por parada no implementado~~ ✓ RESUELTO
La UI ya existía (validación). Faltaba respeto de deadlines en ruta **multi-ciudad**: `optimizeGroups` ignoraba `s.deadline`. Corregido: dentro de cada grupo se rutean primero las paradas con deadline (ordenadas por hora), luego las normales. Además, los grupos con deadline se visitan antes que los grupos sin deadline.

### ~~5. Botón "Volver atrás" no funciona en todas las pantallas~~ ✓ RESUELTO
Dos problemas: (a) Los botones de header usaban `go(prev)` que empuja una entrada nueva al historial en vez de hacer pop → bucle con botón del dispositivo. Corregido a `history.back()` en stops, map, detail, settings. (b) El botón del wizard siempre iba a home sin importar el step. Corregido con `wizardBack()`: ws3+validación → cancelValidation(); ws3+procesando → ws2; ws2 → ws1; ws1 → history.back().

## Notas de Arquitectura

- Las paradas con ciudad diferente generan ítems `isCityHeader` en el array `R[]` para la agrupación visual.
- Los colores por ciudad se asignan desde `CITY_COLORS`.
- El patrón `routeGroups` agrupa las paradas antes de enviarlas al ruteo OSRM.
- El geocaché SQLite evita llamadas repetidas a la API de geocodificación; endpoints: `/api/geocode/cache`.
