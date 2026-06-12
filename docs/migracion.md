# Documentación de Migración SmartHome → HubSpot

## Visión general

Los datos se obtienen desde la API REST de **SmartHome V1** y se cargan en **HubSpot CRM** usando la API de objetos. La migración es idempotente: si se ejecuta más de una vez, los registros existentes se actualizan y los nuevos se crean, sin errores ni duplicados.

---

## 1. Unidades (Apartamentos)

### Origen — SmartHome API

**Endpoint:**
```
GET https://api.smart-home.com.co/api/v1/getUnits/{companyCode}/{projectCode}
```

**Respuesta:** Array de unidades bajo la clave `units`. Cada unidad representa un apartamento del proyecto.

**Campos relevantes recibidos:**

| Campo SmartHome       | Descripción                        |
|-----------------------|------------------------------------|
| `code`                | Nombre del apartamento (ej. "TORRE 1 Apto 0801") |
| `floor`               | Piso                               |
| `building`            | Torre                              |
| `privateArea`         | Área privada (m²)                  |
| `balconyArea`         | Área terraza/balcón (m²)           |
| `price`               | Precio base                        |
| `totalPrice`          | Valor comercial total              |
| `bedroom`             | Número de alcobas                  |
| `bathrooms`           | Número de baños                    |
| `type`                | Tipo de apartamento ("A", "B", etc.) |
| `status`              | Estado numérico (1–4)              |
| `moduleId`            | ID interno de SmartHome            |
| `garageNumber`        | Número de garajes                  |
| `storageNumber`       | Número de depósitos                |
| `propertyView`        | Tipo de vista                      |
| `scheduledForDelivery`| Fecha estimada de entrega          |

### Transformaciones aplicadas

- `code`: `"TORRE 1 Apto 0801"` → `"T1 Apto 0801"` (abreviación para garantizar unicidad entre torres)
- `status`: Numérico → texto (`1→Disponible`, `2→Separado`, `3→Vendido`, `4→Reservado`)
- `bedroom`: Número → enum (`0→Studio (0)`, `5+→5+`, resto como string)
- `bathrooms`: Número → enum (`4+→4+`, resto como string)
- `type`: Letra → `"Tipo A"`, `"Tipo B"`, etc.
- `property_type`: Siempre `"Apartamento"` (campo fijo)

### Destino — HubSpot

**Objeto:** `unt_unidad` (objeto personalizado)  
**Object Type ID:** `2-62473196`  
**Clave de upsert:** `codigo_unidad` (propiedad con valor único)

**Mapeo de campos:**

| SmartHome             | HubSpot                   |
|-----------------------|---------------------------|
| `code` (transformado) | `codigo_unidad`           |
| `floor`               | `piso`                    |
| `building`            | `torre`                   |
| `privateArea`         | `private_area_m2`         |
| `balconyArea`         | `terrace_area_m2`         |
| `price`               | `unit_price`              |
| `totalPrice`          | `valor_unidad_comercial`  |
| `bedroom`             | `number_bedrooms`         |
| `bathrooms`           | `number_bathrooms`        |
| `type`                | `tipo_de_apartamento`     |
| `status`              | `unit_status`             |
| `moduleId`            | `smarthome_module_id`     |
| `garageNumber`        | `no_garajes`              |
| `storageNumber`       | `no_depositos`            |
| `propertyView`        | `view_type`               |
| `scheduledForDelivery`| `fecha_entrega`           |
| *(fijo)*              | `property_type` = `"Apartamento"` |

> **Nota:** `built_area_m2` es un campo calculado en HubSpot y no se puede escribir directamente.

### Ejecución

```bash
# Prueba con 2 unidades
npm run migrate:test-units

# Migración completa (288 unidades)
npm run migrate:all-units

# Limpiar todas las unidades del sandbox
npm run clean:units
```

---

## 2. Contactos (Compradores)

### Origen — SmartHome API

SmartHome no tiene un endpoint exclusivo de contactos. Los datos de contacto están embebidos dentro de los registros de ventas/prospectos.

**Endpoint:**
```
GET https://api.smart-home.com.co/api/v1/getSales/{companyCode}/{projectCode}
```

**Respuesta:** Array de prospectos bajo la clave `prospects`. Cada prospecto representa una venta o proceso de compra y contiene los datos personales del comprador.

**Campos relevantes recibidos:**

| Campo SmartHome         | Descripción                        |
|-------------------------|------------------------------------|
| `firstName`             | Nombre(s)                          |
| `lastName`              | Apellido(s)                        |
| `email`                 | Correo electrónico                 |
| `phoneNumber`           | Teléfono fijo                      |
| `secondPhoneNumber`     | Teléfono alternativo               |
| `mobileNumber`          | Celular                            |
| `address`               | Dirección de residencia            |
| `city`                  | Ciudad                             |
| `identificationNumber`  | Número de cédula                   |
| `prospectId`            | ID único del prospecto en SmartHome|
| `moduleId`              | ID de la unidad vinculada          |

> **Total de registros:** 161 prospectos. Todos son únicos por `prospectId`. No hay duplicados por cédula.

### Transformaciones aplicadas

- `email`: Se aplica `.trim()` y `.toLowerCase()` para limpiar espacios y capitalización
- **Emails duplicados:** Si dos contactos comparten el mismo correo (caso detectado: Sandra Nuñez y Diana Nuñez, ambas con `gerencia@electrobobinados.com`), ambas se crean sin email. HubSpot no permite que dos contactos tengan el mismo email. El campo queda vacío para revisión manual.
- `phone`: Se usa `phoneNumber` con fallback a `secondPhoneNumber` si el primero está vacío

### Destino — HubSpot

**Objeto:** `contacts` (objeto estándar de HubSpot)  
**Clave de upsert:** `smarthome_prospect_id` (propiedad personalizada creada automáticamente por el script)

**Mapeo de campos:**

| SmartHome               | HubSpot                   |
|-------------------------|---------------------------|
| `firstName`             | `firstname`               |
| `lastName`              | `lastname`                |
| `email`                 | `email`                   |
| `phoneNumber`           | `phone`                   |
| `mobileNumber`          | `mobilephone`             |
| `address`               | `address`                 |
| `city`                  | `city`                    |
| `identificationNumber`  | `identification_number`   |
| `prospectId`            | `smarthome_prospect_id`   |

### Propiedad creada automáticamente

El script verifica y crea si no existe:

| Propiedad               | Tipo   | Descripción                        |
|-------------------------|--------|------------------------------------|
| `smarthome_prospect_id` | string | ID del prospecto en SmartHome. Valor único por contacto. |

### Ejecución

```bash
# Prueba con 2 contactos
npm run migrate:test-contacts

# Migración completa (161 contactos)
npm run migrate:all-contacts

# Limpiar contactos importados desde SmartHome
npm run clean:contacts
```

---

## Autenticación

Las llamadas a HubSpot usan una **Clave de servicio** (`pat-na1-...`) almacenada en el archivo `.env`:

```
HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxxxxxxxxxxxxxx
```

Este token es permanente y no expira. Para migrar a **producción**, reemplaza el token por el de la cuenta de producción sin cambiar ningún otro archivo.

---

## Archivos del proyecto

```
Migraciion_Hubspot/
├── .env                          ← Token de HubSpot (no compartir)
├── package.json                  ← Scripts npm
├── data/
│   ├── units_raw.json            ← Cache de unidades (SmartHome)
│   └── contacts_raw.json         ← Cache de contactos (SmartHome)
├── logs/
│   ├── migration_log.json        ← Log de migración de unidades
│   ├── migration_contacts_log.json ← Log de migración de contactos
│   ├── clean_log.json            ← Log de limpieza de unidades
│   └── clean_contacts_log.json   ← Log de limpieza de contactos
├── scripts/
│   ├── auth.js                   ← Manejo de token HubSpot
│   ├── migrate-units.js          ← Migración de unidades
│   ├── migrate-contacts.js       ← Migración de contactos
│   ├── clean-units.js            ← Limpieza de unidades
│   └── clean-contacts.js         ← Limpieza de contactos
└── docs/
    ├── migracion.md              ← Este documento
    └── field-mapping.md          ← Mapeo detallado de campos
```

---

## Notas importantes

- Los archivos `data/*.json` son caché local. Si SmartHome actualiza los datos y quieres refrescarlos, elimina el archivo correspondiente antes de correr la migración.
- El script de limpieza de contactos (`clean:contacts`) **solo elimina contactos que tienen `smarthome_prospect_id`** — no toca contactos existentes que no vengan de SmartHome.
- El script de limpieza de unidades elimina **todas** las unidades del portal.
