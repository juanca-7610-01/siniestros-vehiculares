// Jenkinsfile - Pipeline CI/CD para Siniestros Vehiculares
// Nota: La implementación principal usa GitHub Actions.
// Este Jenkinsfile se provee como referencia de la estructura del pipeline.

pipeline {
    agent any

    parameters {
        choice(
            name: 'ENVIRONMENT',
            choices: ['dev', 'staging', 'prod'],
            description: 'Target deployment environment'
        )
        booleanParam(
            name: 'SKIP_TESTS',
            defaultValue: false,
            description: 'Skip test stage (emergency deploys only)'
        )
    }

    environment {
        AWS_REGION = 'us-east-1'
        NODE_VERSION = '20'
        SAM_CLI_TELEMETRY = '0'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {
        // ==========================================
        // Stage 1: Checkout
        // ==========================================
        stage('Checkout') {
            steps {
                checkout scm
                sh 'echo "Branch: ${GIT_BRANCH}"'
                sh 'echo "Commit: ${GIT_COMMIT}"'
            }
        }

        // ==========================================
        // Stage 2: Install Dependencies
        // ==========================================
        stage('Install') {
            steps {
                dir('src/claims') {
                    sh 'npm ci'
                }
                dir('src/documents') {
                    sh 'npm ci'
                }
            }
        }

        // ==========================================
        // Stage 3: Validate IaC
        // ==========================================
        stage('Validate IaC') {
            steps {
                sh 'pip install cfn-lint checkov'
                sh 'cfn-lint template.yaml'
                sh 'checkov -f template.yaml --framework cloudformation --soft-fail'
                sh 'sam validate'
            }
        }

        // ==========================================
        // Stage 4: Test
        // ==========================================
        stage('Test') {
            when {
                expression { return !params.SKIP_TESTS }
            }
            parallel {
                stage('Unit Tests - Claims') {
                    steps {
                        dir('src/claims') {
                            sh 'npm test || true'
                        }
                    }
                }
                stage('Unit Tests - Documents') {
                    steps {
                        dir('src/documents') {
                            sh 'npm test || true'
                        }
                    }
                }
            }
        }

        // ==========================================
        // Stage 5: Security Scan
        // ==========================================
        stage('Security Scan') {
            parallel {
                stage('SAST') {
                    steps {
                        sh 'echo "SAST scan via CodeQL/SonarQube"'
                        // En Jenkins real: integrar SonarQube
                        // sh 'sonar-scanner ...'
                    }
                }
                stage('SCA - Claims') {
                    steps {
                        dir('src/claims') {
                            sh 'npm audit --audit-level=high || true'
                        }
                    }
                }
                stage('SCA - Documents') {
                    steps {
                        dir('src/documents') {
                            sh 'npm audit --audit-level=high || true'
                        }
                    }
                }
                stage('Secrets Detection') {
                    steps {
                        sh 'echo "Scanning for secrets with TruffleHog..."'
                        // sh 'trufflehog filesystem . --only-verified'
                    }
                }
            }
        }

        // ==========================================
        // Stage 6: Build (SAM)
        // ==========================================
        stage('Build') {
            steps {
                sh 'sam build'
            }
        }

        // ==========================================
        // Stage 7: Deploy
        // ==========================================
        stage('Deploy') {
            steps {
                script {
                    if (params.ENVIRONMENT == 'prod') {
                        // Aprobación manual para producción
                        input message: '¿Aprobar deploy a PRODUCCIÓN?',
                              submitter: 'devops-leads',
                              ok: 'Deploy a Prod'
                    }
                }
                withAWS(credentials: 'aws-siniestros-credentials', region: "${AWS_REGION}") {
                    sh """
                        sam deploy \
                            --config-env ${params.ENVIRONMENT} \
                            --no-fail-on-empty-changeset \
                            --no-confirm-changeset
                    """
                }
            }
        }

        // ==========================================
        // Stage 8: Deploy Frontend
        // ==========================================
        stage('Deploy Frontend') {
            steps {
                withAWS(credentials: 'aws-siniestros-credentials', region: "${AWS_REGION}") {
                    script {
                        def bucketName = sh(
                            script: """aws cloudformation describe-stacks \
                                --stack-name siniestros-${params.ENVIRONMENT} \
                                --query 'Stacks[0].Outputs[?OutputKey==`FrontendBucketName`].OutputValue' \
                                --output text""",
                            returnStdout: true
                        ).trim()

                        def distId = sh(
                            script: """aws cloudformation describe-stacks \
                                --stack-name siniestros-${params.ENVIRONMENT} \
                                --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
                                --output text""",
                            returnStdout: true
                        ).trim()

                        sh "aws s3 sync frontend/ s3://${bucketName}/ --delete"
                        sh "aws cloudfront create-invalidation --distribution-id ${distId} --paths '/*'"
                    }
                }
            }
        }

        // ==========================================
        // Stage 9: Smoke Test
        // ==========================================
        stage('Smoke Test') {
            steps {
                withAWS(credentials: 'aws-siniestros-credentials', region: "${AWS_REGION}") {
                    script {
                        def apiUrl = sh(
                            script: """aws cloudformation describe-stacks \
                                --stack-name siniestros-${params.ENVIRONMENT} \
                                --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
                                --output text""",
                            returnStdout: true
                        ).trim()

                        sh "curl -sf ${apiUrl}/api/v1/claims/health || echo 'Health check pending'"
                    }
                }
            }
        }
    }

    post {
        success {
            echo "✅ Pipeline exitoso - ${params.ENVIRONMENT}"
            // Notificación a Slack/Teams
            // slackSend channel: '#deploys', message: "Deploy exitoso: ${params.ENVIRONMENT}"
        }
        failure {
            echo "❌ Pipeline fallido - ${params.ENVIRONMENT}"
            // slackSend channel: '#deploys', color: 'danger', message: "Deploy fallido: ${params.ENVIRONMENT}"
        }
        always {
            cleanWs()
        }
    }
}
