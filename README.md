# Siniestros Vehiculares - Plataforma Serverless AWS

## Arquitectura

```
[Agente] → [CloudFront + WAF] → [S3 Frontend (SPA React)]
                   ↓
           [API Gateway REST]
                   ↓
           [Lambda Functions (Node.js 20.x, arm64)]
                   ↓
           [DynamoDB Table (on-demand, encrypted KMS)]
```

## Estructura del Proyecto

```
├── template.yaml                # SAM template (IaC)
├── samconfig.toml               # Config SAM por ambiente
├── src/
│   ├── claims/index.mjs         # Lambda claims
│   └── documents/index.mjs      # Lambda documents
├── .github/workflows/
│   ├── ci.yml                   # CI: test + security
│   ├── deploy.yml               # CD: deploy por ambiente
│   └── rollback.yml             # Rollback automático
├── configs/
│   ├── dev.json
│   ├── staging.json
│   └── prod.json
├── tests/
│   └── unit/
└── docs/
    └── PROPUESTA.md             # Propuesta técnica
```

## Quick Start

```bash
sam build
sam deploy --config-env dev
```

## Pipeline CI/CD (GitHub Actions)

| Branch    | Ambiente | Tipo Deploy      |
|-----------|----------|------------------|
| develop   | dev      | Automático       |
| staging   | staging  | Automático       |
| main      | prod     | Manual approval  |

## Estrategia de Despliegue

- **Lambda**: Canary deployment (AWS CodeDeploy) con rollback automático
- **Frontend**: S3 sync + CloudFront invalidation
- **Rollback**: Automático si CloudWatch alarm se activa en ventana de 5 min
