# Mapeo de Campos: SmartHome V1 → HubSpot Unidades

## Claves de acceso
- Company Code: `588652b8`
- Project Code: `e8fd1240`
- Endpoint SmartHome: `GET /api/v1/getUnits/{companyCode}/{projectCode}`

---

## Objeto HubSpot
- **name:** `unt_unidad`
- **objectTypeId:** `2-62473196`
- **label:** Unidad (Inmuebles)

---

## Mapeo de campos

| Campo SmartHome | Tipo SM | Nombre API HubSpot | Label HubSpot | Tipo HS | Notas |
|---|---|---|---|---|---|
| `code` | string | `codigo_unidad` | Nomenclatura | string | ✅ |
| `floor` | number | `piso` | Piso | number | ✅ |
| `building` | string | `torre` | Torre | enumeration | ⚠️ Ver valores dropdown abajo |
| `privateArea` | number | `private_area_m2` | Área Apartamento (m²) | number | ✅ |
| `balconyArea` | number | `terrace_area_m2` | Área Terraza (m²) | number | ✅ |
| `totalArea` | number | `built_area_m2` | Área Total (m²) | number | ✅ Escribible |
| `status` | number | `unit_status` | Estado del Inmueble | enumeration | ⚠️ Ver mapeo abajo |
| `bedroom` | number | `number_bedrooms` | No. de Alcobas | enumeration | ⚠️ Ver valores dropdown abajo |
| `bathrooms` | number | `number_bathrooms` | No. de Baños | enumeration | ⚠️ Ver valores dropdown abajo |
| `price` | number | `unit_price` | Precio | number | ✅ |
| `type` | string | `tipo_de_apartamento` | Tipo de apartamento | enumeration | ⚠️ Valores no coinciden — ver abajo |
| `propertyView` | string | `view_type` | Vista | enumeration | ⚠️ Valores: Botanika, Senderos |
| `totalPrice` | number | `valor_unidad_comercial` | Valor unidad (Comercial) | number | ✅ |
| `moduleId` | string | *(no existe)* | ID SmartHome | — | ❌ Crear propiedad nueva |
| `garageNumber` | number | *(no existe)* | No. de Garajes | — | ❌ Crear propiedad nueva |
| `storageNumber` | number | *(no existe)* | No. de Depósitos | — | ❌ Crear propiedad nueva |
| `scheduledForDelivery` | date | *(no existe)* | Fecha Entrega Programada | — | ❌ Crear propiedad nueva |
| `garagePrice` | number | *(omitir)* | — | — | Sin equivalente |
| `storagePrice` | number | *(omitir)* | — | — | Sin equivalente |
| `lotArea` | number | *(omitir)* | — | — | Sin equivalente |
| `reservations` | array | *(omitir)* | — | — | Dato de otro módulo |

---

## Mapeo de estado (status SmartHome → unit_status HubSpot)

| Código SM | Texto SM | Valor HubSpot | Notas |
|---|---|---|---|
| 1 | Disponible | `Disponible` | ✅ |
| 2 | Separado | `Separado` | ✅ |
| 3 | Vendido | `Vendido` | ✅ |
| 4 | Reservado | `Reservado` | ✅ |
| 5 | Escriturado | `No Disponible` | ⚠️ No existe "Escriturado" — agregar opción o mapear |
| 6 | Canje | `No Disponible` | ⚠️ No existe "Canje" — agregar opción o mapear |
| 7 | Arrendado | `No Disponible` | ⚠️ No existe "Arrendado" — agregar opción o mapear |
| 8 | VendidoYArrendado | `No Disponible` | ⚠️ No existe equivalente — agregar opción o mapear |

## Valores de dropdowns confirmados

**torre:** `1`, `2`, `3`, `4`, `5`
- SmartHome `building` es string "2" → mapea directamente

**number_bathrooms:** `1`, `1.5`, `2`, `2.5`, `3`, `3.5`, `4+`
- SmartHome `bathrooms` es número → convertir a string, si ≥4 usar `4+`

**number_bedrooms:** `Studio (0)`, `1`, `2`, `3`, `4`, `5+`
- SmartHome `bedroom` es número → si 0 usar `Studio (0)`, si ≥5 usar `5+`

**tipo_de_apartamento:** `Tipo A`, `Tipo B`, `Tipo C`, `Tipo D`, `Tipo E`
- SmartHome `type` es string como "B", "B+", "C" → ⚠️ No coinciden directamente, requiere mapeo manual

**view_type:** `Botanika`, `Senderos`
- SmartHome `propertyView` es string → verificar qué valores vienen de la API

---

## Propiedades HubSpot SIN equivalente en SmartHome
*(se dejan vacías en la migración inicial)*

- Bono
- Cliente Comprador
- Código del Inmueble en Fiducia
- Descripción del Inmueble
- Link de Imagen de la Vista
- Link de Planos
- Link Tour Virtual
- Negocio Asociado
- No. de aires
- Nombre de la Fiduciaria
- Nombre del Vendedor
- Proyecto / Proyecto inmobiliario
- Tipo de unidad
- Valor m² (Comercial / Con descuento / Factibilidad)
- Valor unidad (Con descuento / Factibilidad)
- Etapa

---

## Propiedades nuevas a crear en HubSpot (recomendadas)

| Nombre sugerido | Tipo | Razón |
|---|---|---|
| ID SmartHome | Texto | `moduleId` — clave para deduplicación y sync futuro |
| No. de Garajes | Número | `garageNumber` |
| No. de Depósitos | Número | `storageNumber` |
| Fecha Entrega Programada | Fecha | `scheduledForDelivery` |

---

## Pendiente
- [ ] Crear 4 propiedades nuevas en HubSpot: `smarthome_module_id`, `no_garajes`, `no_depositos`, `fecha_entrega`
- [ ] Decidir: ¿agregar opciones faltantes en `unit_status` (Escriturado, Canje, Arrendado) o mapear a "No Disponible"?
- [ ] Confirmar mapeo de `tipo_de_apartamento` (SM: "B", "B+", "C" → HS: "Tipo A", "Tipo B"...)
- [ ] Verificar valores reales de `propertyView` en SmartHome API
