import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET || `siniestros-documents-${process.env.ENVIRONMENT}`;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  },
  body: JSON.stringify(body),
});

async function generateReport(event) {
  const body = JSON.parse(event.body);

  if (!body.claimId) {
    return response(400, { error: 'Campo requerido: claimId' });
  }

  // Obtener datos del siniestro
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLAIM#${body.claimId}`, SK: 'METADATA' },
  }));

  if (!result.Item) {
    return response(404, { error: 'Siniestro no encontrado' });
  }

  const claim = result.Item;

  // Generar contenido del reporte (texto plano como placeholder)
  // En producción se usaría una librería como pdfkit o puppeteer en Lambda Layer
  const reportContent = generateReportContent(claim);
  const reportKey = `reports/${body.claimId}/${Date.now()}-report.txt`;

  // Subir a S3
  await s3Client.send(new PutObjectCommand({
    Bucket: DOCUMENTS_BUCKET,
    Key: reportKey,
    Body: reportContent,
    ContentType: 'text/plain',
    ServerSideEncryption: 'aws:kms',
    Metadata: {
      claimId: body.claimId,
      generatedAt: new Date().toISOString(),
      environment: process.env.ENVIRONMENT || 'dev',
    },
  }));

  console.info(JSON.stringify({ 
    action: 'GENERATE_REPORT', 
    claimId: body.claimId, 
    reportKey 
  }));

  return response(201, {
    message: 'Reporte generado exitosamente',
    claimId: body.claimId,
    reportKey,
    bucket: DOCUMENTS_BUCKET,
  });
}

function generateReportContent(claim) {
  return `
=====================================
REPORTE DE SINIESTRO VEHICULAR
=====================================
ID Siniestro:    ${claim.claimId}
Póliza:          ${claim.policyNumber}
Placa:           ${claim.vehiclePlate}
Estado:          ${claim.status}
Ubicación:       ${claim.location}
Descripción:     ${claim.description}
Agente:          ${claim.agentId}
Fecha Registro:  ${claim.createdAt}
Última Actualización: ${claim.updatedAt}
${claim.resolution ? `Resolución:      ${claim.resolution}` : ''}
=====================================
Generado: ${new Date().toISOString()}
Ambiente: ${process.env.ENVIRONMENT}
=====================================
`.trim();
}

export const handler = async (event) => {
  console.info(JSON.stringify({
    action: 'REQUEST',
    method: event.httpMethod,
    path: event.path,
    requestId: event.requestContext?.requestId,
  }));

  try {
    if (event.httpMethod === 'POST') {
      return await generateReport(event);
    }
    return response(405, { error: 'Método no permitido' });
  } catch (error) {
    console.error(JSON.stringify({ action: 'ERROR', error: error.message, stack: error.stack }));
    return response(500, { error: 'Error interno del servidor' });
  }
};
