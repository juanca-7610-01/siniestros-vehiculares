import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Helpers
const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'X-Request-Id': body.requestId || 'unknown',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  },
  body: JSON.stringify(body),
});

const generateId = () => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CLM-${timestamp}-${random}`.toUpperCase();
};

// Handlers por método
async function createClaim(event) {
  const body = JSON.parse(event.body);
  const claimId = generateId();
  const now = new Date().toISOString();

  // Validación básica
  const required = ['policyNumber', 'vehiclePlate', 'description', 'location'];
  for (const field of required) {
    if (!body[field]) {
      return response(400, { error: `Campo requerido: ${field}` });
    }
  }

  const item = {
    PK: `CLAIM#${claimId}`,
    SK: `METADATA`,
    GSI1PK: `POLICY#${body.policyNumber}`,
    GSI1SK: `CLAIM#${now}`,
    claimId,
    policyNumber: body.policyNumber,
    vehiclePlate: body.vehiclePlate,
    description: body.description,
    location: body.location,
    status: 'REGISTERED',
    agentId: body.agentId || 'unknown',
    createdAt: now,
    updatedAt: now,
    environment: ENVIRONMENT,
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  console.info(JSON.stringify({ action: 'CREATE_CLAIM', claimId, policyNumber: body.policyNumber }));

  return response(201, { message: 'Siniestro registrado', claimId, status: 'REGISTERED' });
}

async function getClaim(event) {
  const claimId = event.pathParameters.id;

  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLAIM#${claimId}`, SK: 'METADATA' },
  }));

  if (!result.Item) {
    return response(404, { error: 'Siniestro no encontrado' });
  }

  // Remover keys internas de DynamoDB
  const { PK, SK, GSI1PK, GSI1SK, ...claim } = result.Item;

  console.info(JSON.stringify({ action: 'GET_CLAIM', claimId }));

  return response(200, claim);
}

async function updateClaim(event) {
  const claimId = event.pathParameters.id;
  const body = JSON.parse(event.body);
  const now = new Date().toISOString();

  const allowedUpdates = ['status', 'description', 'location', 'resolution'];
  const updates = {};

  for (const field of allowedUpdates) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return response(400, { error: 'No hay campos válidos para actualizar' });
  }

  const updateExpressions = [];
  const expressionValues = {};
  const expressionNames = {};

  for (const [key, value] of Object.entries(updates)) {
    updateExpressions.push(`#${key} = :${key}`);
    expressionValues[`:${key}`] = value;
    expressionNames[`#${key}`] = key;
  }

  updateExpressions.push('#updatedAt = :updatedAt');
  expressionValues[':updatedAt'] = now;
  expressionNames['#updatedAt'] = 'updatedAt';

  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CLAIM#${claimId}`, SK: 'METADATA' },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionValues,
      ExpressionAttributeNames: expressionNames,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return response(404, { error: 'Siniestro no encontrado' });
    }
    throw err;
  }

  console.info(JSON.stringify({ action: 'UPDATE_CLAIM', claimId, updates: Object.keys(updates) }));

  return response(200, { message: 'Siniestro actualizado', claimId });
}

// Handler principal
export const handler = async (event) => {
  console.info(JSON.stringify({ 
    action: 'REQUEST', 
    method: event.httpMethod, 
    path: event.path,
    requestId: event.requestContext?.requestId 
  }));

  try {
    switch (event.httpMethod) {
      case 'POST':
        return await createClaim(event);
      case 'GET':
        return await getClaim(event);
      case 'PATCH':
        return await updateClaim(event);
      default:
        return response(405, { error: 'Método no permitido' });
    }
  } catch (error) {
    console.error(JSON.stringify({ action: 'ERROR', error: error.message, stack: error.stack }));
    return response(500, { error: 'Error interno del servidor' });
  }
};
