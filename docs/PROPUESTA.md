# Propuesta Técnica - Ingeniero DevOps
## Plataforma de Registro de Siniestros Vehiculares

---

## 1. Pipeline CI/CD (GitHub Actions)

### Diseño del Pipeline

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Checkout   │ →  │    Build    │ →  │    Test     │ →  │  Security   │ →  │   Deploy    │
│             │    │  sam build  │    │  unit tests │    │  Scan       │    │  SAM deploy │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Flujo por Rama

| Rama      | Ambiente | Tipo de Deploy    | Aprobación |
|-----------|----------|-------------------|------------|
| develop   | dev      | AllAtOnce         | Automático |
| staging   | staging  | AllAtOnce         | Automático |
| main      | prod     | Canary 10%/5min   | Manual (GitHub Environment Protection) |

### Aprobación Manual para Producción

Se utiliza **GitHub Environments** con reglas de protección:
- Se configura el environment `prod` con "Required reviewers"
- El workflow se pausa hasta que un reviewer apruebe
- Timeout configurable (ej: 72 horas)

### Archivos del Pipeline

- `.github/workflows/ci.yml` — Validación, tests y security scans
- `.github/workflows/deploy.yml` — Despliegue diferenciado por ambiente
- `.github/workflows/rollback.yml` — Rollback manual de emergencia

---

## 2. IaC y Gestión de Ambientes

### Consistencia entre Ambientes

**Estrategia: Single Template + Parameter Overrides**

Se usa un único `template.yaml` (SAM/CloudFormation) parametrizado por ambiente. El archivo `samconfig.toml` define los parámetros específicos de cada ambiente:

```toml
[dev.deploy.parameters]
parameter_overrides = "Environment=dev LogLevel=DEBUG RetentionDays=7"

[prod.deploy.parameters]
parameter_overrides = "Environment=prod LogLevel=WARN RetentionDays=365"
```

**Beneficios:**
- Un solo template garantiza paridad estructural
- Los parámetros controlan diferencias legítimas (log level, retención, estrategia de deploy)
- Uso de `Conditions` en CloudFormation para recursos que solo aplican en prod

### Validación de Templates

1. **cfn-lint**: Validación sintáctica y de buenas prácticas del template
2. **checkov**: Escaneo de seguridad del IaC (misconfigurations)
3. **sam validate**: Validación específica de SAM
4. **sam build**: Compilación local antes del deploy

Todo esto se ejecuta en el job `validate` del CI pipeline antes de cualquier deploy.

### Manejo de Secretos

- **AWS Secrets Manager**: Almacena credenciales de integraciones
- **AWS KMS**: Encriptación de secretos at-rest
- **GitHub Secrets**: Almacena el ARN del rol IAM para OIDC
- **Nunca en el repositorio**: `.gitignore` excluye archivos `.env`
- **Referencia por ARN**: Las Lambdas acceden a secretos en runtime via SDK, no como variables de entorno

```yaml
# En template.yaml - la Lambda tiene permiso para leer secretos
- Effect: Allow
  Action: secretsmanager:GetSecretValue
  Resource: !Sub arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:siniestros/${Environment}/*
```

---

## 3. Estrategia de Despliegue

### Lambda: Canary Deployment

**Producción**: `Canary10Percent5Minutes`
- Se enruta 10% del tráfico a la nueva versión
- Si la alarma de errores no se activa en 5 minutos, se promueve al 100%
- Si se activa la alarma → **rollback automático** via AWS CodeDeploy

**Dev/Staging**: `AllAtOnce`
- Deploy inmediato sin canary (rapidez en desarrollo)

### Rollback Automático

```yaml
DeploymentPreference:
  Type: Canary10Percent5Minutes
  Alarms:
    - !Ref ClaimsErrorAlarm  # Si errors > 5 en 3 minutos → rollback
```

CodeDeploy monitorea las CloudWatch Alarms durante el periodo canary. Si una alarma pasa a estado ALARM, revierte automáticamente al alias anterior.

### Rollback Manual

El workflow `rollback.yml` permite:
1. Seleccionar ambiente
2. Confirmar con texto "CONFIRM"
3. Revertir alias de Lambda a la versión anterior

### Frontend: S3 + CloudFront Invalidation

```bash
# 1. Build del frontend
npm run build

# 2. Sync a S3 (elimina archivos obsoletos)
aws s3 sync dist/ s3://$BUCKET/ --delete

# 3. Invalidar caché de CloudFront
aws cloudfront create-invalidation --distribution-id $ID --paths "/*"
```

---

## 4. Seguridad Integrada (DevSecOps)

### Herramientas en el Pipeline

| Tipo | Herramienta | Propósito |
|------|-------------|-----------|
| SAST | CodeQL (GitHub) | Análisis estático de código fuente |
| SCA | npm audit | Vulnerabilidades en dependencias |
| IaC Scan | cfn-lint + checkov | Misconfigurations en infraestructura |
| Secrets | TruffleHog | Detección de secretos en código |

### Manejo de Vulnerabilidades

**Política de bloqueo vs advertencia:**

| Severidad | Acción | Ejemplo |
|-----------|--------|---------|
| Critical/High | **Bloqueo** — PR no puede mergearse | RCE, SQL injection |
| Medium | **Advertencia** — notificación al equipo | XSS en dependencia indirecta |
| Low | **Log** — registro para revisión futura | Info disclosure menor |

**Implementación:**
- `npm audit --audit-level=high` → falla el build si hay High/Critical
- CodeQL → configura severities que bloquean merge
- checkov → `--soft-fail` para advertencias, `--hard-fail` para reglas críticas

### Cumplimiento SFC (Superintendencia Financiera de Colombia)

| Requisito SFC | Implementación |
|---------------|----------------|
| Protección de PII | Encriptación KMS en DynamoDB y S3 |
| Auditoría | CloudTrail habilitado, logs con retención 365 días en prod |
| Control de acceso | IAM least privilege, no hay acceso público a datos |
| Trazabilidad | X-Ray tracing + Request IDs en todas las respuestas |
| Disponibilidad | Multi-AZ implícito (Lambda, DynamoDB, S3) |
| Retención de datos | Point-in-Time Recovery en DynamoDB prod |
| Cifrado en tránsito | HTTPS obligatorio (CloudFront redirect-to-https) |

---

## 5. Observabilidad

### Stack de Monitoreo

```
┌─────────────────────────────────────────────────┐
│              AWS CloudWatch                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   Logs   │  │ Metrics  │  │  Dashboards  │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│              ↕                                    │
│  ┌──────────────────────────────────────────┐   │
│  │         CloudWatch Alarms                 │   │
│  │  • Error Rate > 5 en 3 min               │   │
│  │  • Latencia P99 > 3s                     │   │
│  │  • Throttles detectados                   │   │
│  └──────────────────────────────────────────┘   │
│              ↕                                    │
│  ┌──────────────────────────────────────────┐   │
│  │          AWS X-Ray (Tracing)              │   │
│  │  • Trazabilidad end-to-end               │   │
│  │  • Service Map                            │   │
│  │  • Latency breakdown                     │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Alertas Críticas

| Alerta | Condición | Acción |
|--------|-----------|--------|
| Lambda Errors | > 5 errores en 3 min | Notificación + trigger rollback en canary |
| API Latency P99 | > 3 segundos en 10 min | Notificación al equipo |
| DynamoDB Throttles | Cualquier throttle | Notificación + revisar capacity |
| 5xx Error Rate | > 5% del total | Alerta crítica |

### Métricas DORA

| Métrica | Cómo se mide |
|---------|-------------|
| **Deployment Frequency** | Conteo de ejecuciones exitosas del workflow `deploy.yml` por semana |
| **Lead Time for Changes** | Tiempo desde commit hasta deploy exitoso (GitHub Actions timestamps) |
| **Mean Time to Recovery (MTTR)** | Tiempo desde alarma ALARM hasta resolución (CloudWatch + workflow rollback) |
| **Change Failure Rate** | Deploys que generaron rollback / total deploys (CodeDeploy metrics) |

**Implementación:** GitHub Actions provee timestamps nativos. Se puede extraer con la API de GitHub:
- `workflow_run.created_at` → inicio
- `workflow_run.updated_at` → fin
- Rollbacks contados via workflow `rollback.yml` executions

---

## 6. Integración de AI

### Caso 1: Code Review Automatizado con AI

**Herramienta:** GitHub Copilot para Pull Requests / Amazon CodeGuru Reviewer

**Aplicación:**
- Review automático de PRs antes del merge
- Detecta issues de seguridad, performance y buenas prácticas
- Sugiere mejoras específicas para Lambda (cold starts, memory optimization)
- Valida que el manejo de PII sea correcto

**Implementación en el pipeline:**
```yaml
# Se activa automáticamente en cada PR via GitHub Copilot
# O se integra Amazon CodeGuru Reviewer como step adicional
```

### Caso 2: Análisis Predictivo de Incidentes con Amazon DevOps Guru

**Herramienta:** Amazon DevOps Guru

**Aplicación:**
- Monitoreo ML-based de anomalías en las métricas de la aplicación
- Predicción de incidentes antes de que impacten a usuarios
- Recomendaciones automáticas de remediación
- Análisis de root cause automatizado

**Beneficios específicos:**
- Detecta patrones anómalos en latencia de Lambda antes de que escale
- Identifica correlaciones entre deploys y degradación
- Reduce MTTR al sugerir causa raíz
- Se integra nativamente con CloudFormation stacks

### Caso 3 (Bonus): Generación de IaC con AI

**Herramienta:** Amazon Q Developer

**Aplicación:**
- Generación y refactoring de templates CloudFormation/SAM
- Sugerencias de seguridad y compliance en la IaC
- Troubleshooting de errores de despliegue
- Optimización de configuración de Lambda (memory, timeout)

---

## Resumen de Costos (Free Tier)

| Servicio | Free Tier |
|----------|-----------|
| Lambda | 1M requests + 400K GB-seconds/mes |
| DynamoDB | 25 GB + 25 WCU + 25 RCU |
| API Gateway | 1M llamadas REST/mes |
| CloudFront | 1 TB transfer/mes |
| S3 | 5 GB |
| CloudWatch | 10 métricas custom + 5 GB logs |
| X-Ray | 100K traces/mes |
| CodeDeploy | Gratis para Lambda |

**Costo estimado en producción real (post Free Tier):** < $15 USD/mes para cargas moderadas.

---

## Diagrama de Arquitectura Final

```
                    ┌─────────────┐
                    │   GitHub    │
                    │  Actions    │
                    └──────┬──────┘
                           │ CI/CD
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
       ┌────────┐    ┌────────┐    ┌────────┐
       │  DEV   │    │STAGING │    │  PROD  │
       └────────┘    └────────┘    └────────┘
            │              │              │
            └──────────────┼──────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │         CloudFront + WAF      │
            │         (HTTPS, OAC)          │
            └──────────────┬───────────────┘
                    ┌──────┴──────┐
                    ▼             ▼
            ┌────────────┐ ┌────────────┐
            │ S3 Frontend│ │API Gateway │
            │   (React)  │ │   (REST)   │
            └────────────┘ └─────┬──────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼                         ▼
            ┌────────────┐           ┌────────────┐
            │  Lambda    │           │  Lambda    │
            │  Claims    │           │  Documents │
            │  (arm64)   │           │  (arm64)   │
            └──────┬─────┘           └──────┬─────┘
                   │                        │
                   ▼                        ▼
            ┌────────────┐           ┌────────────┐
            │  DynamoDB  │           │  S3 Docs   │
            │  (KMS enc) │           │  (KMS enc) │
            └────────────┘           └────────────┘
                   │
                   ▼
            ┌────────────────┐
            │Secrets Manager │
            │    + KMS       │
            └────────────────┘
```
