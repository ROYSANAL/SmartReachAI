pipeline {
    agent {
        kubernetes {
            label 'agent-runner'
        } 
    }
    environment{
        PROD_GCS_PROJECT_ID = 'live2ai-prod'
        PROD_CLUSTER_ID = 'gke-live2ai-prod'
        PROD_REPOSITORY_NAME = 'asia.gcr.io/live2ai-prod'
        PROD_BRANCH_NAME = 'origin/main'
        STAGE_GCS_PROJECT_ID = 'live2ai-dev'
        STAGE_CLUSTER_ID = 'gke-live2ai-dev'
        STAGE_REPOSITORY_NAME = 'asia.gcr.io/live2ai-dev'
        MAIN_DOCKER_IMAGE_NAME = 'live2ai-bdr'
        GCS_NAMESPACE = 'live2ai-bdr'
        GIT_SHORT_SHA = sh(script: 'git rev-parse --short HEAD', returnStdout: true)
        GIT_COMMIT_MSG = sh (script: 'git log -1 --pretty=%B ${GIT_COMMIT}', returnStdout: true).trim()
    }
    stages {
        stage('Checkout'){
            steps{
                container('docker'){
                    checkout scm
                    slackSend channel: '#ci-cd-pipeline-alerts', color: '#DFE30E', message: "Pipeline Started for `${MAIN_DOCKER_IMAGE_NAME}`\n `Branch`: *${GIT_BRANCH}*\n `Commit_ID`: ${GIT_SHORT_SHA}\n `Commit`: ${GIT_COMMIT_MSG}", teamDomain: 'woovly-workspace', tokenCredentialId: 'slack-token'
                }
            }
        }
        stage('Prod Build'){
            when { expression { return GIT_BRANCH == PROD_BRANCH_NAME } }
            steps{
                container('docker'){
                    sh 'docker build . -t ${PROD_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                    sh 'docker logout'
                }
            }
        }
        stage('Prod Push to GCR'){
            when { expression { return GIT_BRANCH == PROD_BRANCH_NAME } }
            steps{
                container('gcp-sdk'){
                    withCredentials([file(credentialsId: 'docker-push-key', variable: 'GCS_DOCKER_KEY')]) {
                        sh 'cat ${GCS_DOCKER_KEY} > key.json'
                        sh 'docker login -u _json_key --password-stdin https://asia.gcr.io < key.json'
                        sh 'docker push ${PROD_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                        sh 'docker logout'
                    }
                }
            }
        }
        stage('Prod Deploy'){
            when { expression { return GIT_BRANCH == PROD_BRANCH_NAME } }
            steps{
                container('gcp-sdk'){
                    withCredentials([file(credentialsId: 'k8s-key', variable: 'GCS_k8s_KEY')]) {
                    sh("gcloud auth activate-service-account --key-file=${GCS_k8s_KEY}")}
                    sh 'gcloud config set project ${PROD_GCS_PROJECT_ID}'   
                    sh 'gcloud config set container/cluster ${PROD_CLUSTER_ID}'
                    sh 'gcloud config set compute/region asia-south1'
                    sh 'gcloud container clusters get-credentials gke-live2ai-prod --region asia-south1 --project live2ai-prod'
                    sh 'kubectl -n ${GCS_NAMESPACE} set image deployment/${MAIN_DOCKER_IMAGE_NAME} live2ai-helm=${PROD_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                    sh 'gcloud auth revoke --all'
                } 
            }
        }
        stage('Prod Docker CleanUp'){
            when { expression { return GIT_BRANCH == PROD_BRANCH_NAME } }
            steps{
                container('docker'){
                sh 'docker rmi -f ${PROD_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                sh 'docker images -q -f dangling=true | xargs -r docker rmi || true'
                sh 'docker volume ls -qf dangling=true | xargs -r docker volume rm || true'
                sh 'docker system prune -f'
                }
            }
        }
        stage('Stage Pre build env set') {
            when { expression { return GIT_BRANCH != PROD_BRANCH_NAME } }
            steps {
                container('gcp-sdk'){
                    withCredentials([file(credentialsId: 'sm-key', variable: 'GC_SM_KEY')]) {
                    sh("gcloud auth activate-service-account --key-file=${GC_SM_KEY}")}
                    sh 'gcloud --project ${STAGE_GCS_PROJECT_ID} secrets versions access latest --secret="live2ai-bdr" > .env'
                    sh 'gcloud --project ${STAGE_GCS_PROJECT_ID} secrets versions access latest --secret="live2ai-bdr-key" > googleSheetsKey.json'
                    sh 'cat .env'
                    sh 'cat googleSheetsKey.json'
                    sh 'gcloud auth revoke --all'
                }
            }
        }
        stage('Staging Build'){
            when { expression { return GIT_BRANCH != PROD_BRANCH_NAME } }
            steps{
                container('docker'){
                    sh 'docker build . -t ${STAGE_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                    sh 'docker logout'
                }
            }
        }
        stage('Staging Push to GCR'){
            when { expression { return GIT_BRANCH != PROD_BRANCH_NAME } }
            steps{
                container('gcp-sdk'){
                    withCredentials([file(credentialsId: 'docker-push-key', variable: 'GCS_DOCKER_KEY')]) {
                        sh 'cat ${GCS_DOCKER_KEY} > key.json'
                        sh 'docker login -u _json_key --password-stdin https://asia.gcr.io < key.json'
                        sh 'docker push ${STAGE_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                        sh 'docker logout'
                    }
                }
            }
        }
        stage('Staging Deploy'){
            when { expression { return GIT_BRANCH != PROD_BRANCH_NAME } }
            steps{
                container('gcp-sdk'){
                    withCredentials([file(credentialsId: 'k8s-key', variable: 'GCS_k8s_KEY')]) {
                    sh("gcloud auth activate-service-account --key-file=${GCS_k8s_KEY}")}
                    sh 'gcloud config set project ${STAGE_GCS_PROJECT_ID}'   
                    sh 'gcloud config set container/cluster ${STAGE_CLUSTER_ID}'
                    sh 'gcloud config set compute/region asia-south1'
                    sh 'gcloud container clusters get-credentials gke-live2ai-dev --region asia-south1 --project live2ai-dev'
                    sh 'kubectl -n ${GCS_NAMESPACE} set image deployment/${MAIN_DOCKER_IMAGE_NAME} live2ai-helm=${STAGE_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                    sh 'gcloud auth revoke --all'
                } 
            }
        }
        stage('Staging Docker CleanUp'){
            when { expression { return GIT_BRANCH != PROD_BRANCH_NAME } }
            steps{
                container('docker'){
                sh 'docker rmi -f ${STAGE_REPOSITORY_NAME}/${MAIN_DOCKER_IMAGE_NAME}:${GIT_SHORT_SHA}'
                sh 'docker images -q -f dangling=true | xargs -r docker rmi || true'
                sh 'docker volume ls -qf dangling=true | xargs -r docker volume rm || true'
                sh 'docker system prune -f'
                }
            }
        }
    }
    post {
        always {
            cleanWs(cleanWhenNotBuilt: true,
                    cleanWhenAborted: true,
                    cleanWhenFailure: true,
                    cleanWhenSuccess: true,
                    cleanWhenUnstable: true,
                    deleteDirs: true,
                    disableDeferredWipeout: true,
                    notFailBuild: true)
        }
    }
}