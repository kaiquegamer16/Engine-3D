

class MotorJM {
    /**
     * Construtor da classe MotorJM.
     * @param {string} containerId - O ID do elemento HTML onde o canvas do renderizador será anexado.
     * @param {object} fileSystemReference - Uma referência ao objeto `fileSystem` da UI.
     */
    constructor(containerId, fileSystemReference) { 
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`MotorJM (Erro Fatal): O elemento com o ID '${containerId}' não foi encontrado.`);
            return; 
        }
        
        this.fileSystemReference = fileSystemReference; // Armazena a referência

        // --- Componentes Principais ---
        this.cena = new THREE.Scene();
        this.renderizador = new THREE.WebGLRenderer({ antialias: true }); 
        this.textureLoader = new THREE.TextureLoader(); 
        this.rgbeLoader = new THREE.RGBELoader(); 

        // --- Câmeras ---
        this.editorCamera = null; 
        this.activeCamera = null; 
        this.tempEditorCameraTarget = new THREE.Vector3(); 

        // --- Controles e Interação ---
        this.controlesOrbit = null;
        this.controlesTransform = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.objetoSelecionadoId = null;
        
        // --- Propriedades de Cena ---
        this.cena._backgroundConfig = { color: '#1a1a1a', environmentMapName: 'Nenhuma' }; 

        // --- Física ---
        this.mundoFisica = new CANNON.World();
        this.mundoFisica.solver.iterations = 10;
        this.mundoFisica.defaultContactMaterial.contactEquationStiffness = 1e9;
        this.mundoFisica.defaultContactMaterial.contactEquationRelaxation = 4;

        // --- Estado Interno ---
        this.objetosNaCena = {}; 
        this.estaRodando = false; 
        
        // --- Inicialização ---
        this._configurarRenderizador();
        this._configurarCamera();
        this._configurarIluminacaoPadrao(); // Será chamado de forma mais controlada
        this._configurarMundoFisica();
        this._configurarControles();
        this._configurarEventos();

        console.log("MotorJM (Info): Motor inicializado com sucesso.");
    }

    // --- MÉTODOS DE CONFIGURAÇÃO INTERNA ---

    _configurarRenderizador() {
        this.renderizador.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderizador.shadowMap.enabled = true;
        this.renderizador.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderizador.outputEncoding = THREE.sRGBEncoding;
        this.renderizador.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderizador.toneMappingExposure = 1.0;
        this.renderizador.setPixelRatio(window.devicePixelRatio || 1);
        this.container.appendChild(this.renderizador.domElement);
    }

    _configurarCamera(opcoes = {}) {
        this.editorCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
        this.editorCamera.position.set(0, 10, opcoes.distanciaCameraInicial || 20);
        this.editorCamera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.editorCamera.updateProjectionMatrix();
        
        this.activeCamera = this.editorCamera; 
        this.cena.background = new THREE.Color(this.cena._backgroundConfig.color); 
    }

    _configurarIluminacaoPadrao() {
        // Agora esta função só é chamada se o script do mundo não adicionar suas próprias luzes
        if (!Object.values(this.objetosNaCena).some(obj => obj.type.startsWith('luz_') && !obj.id.endsWith('_padrao_removivel'))) {
            this.adicionarLuz('luz_ambiente_padrao_removivel', 'Ambiente Padrão', { type: 'ambiente', color: 0xffffff, intensity: 0.3 });
            this.adicionarLuz('luz_direcional_padrao_removivel', 'Direcional Padrão', { type: 'direcional', color: 0xffffff, intensity: 1, position: new THREE.Vector3(10, 20, 10), castShadow: true });
        }
    }

    _configurarMundoFisica(opcoes = {}) {
        this.mundoFisica.gravity.copy(opcoes.gravidade || new CANNON.Vec3(0, -9.82, 0));
        this.mundoFisica.broadphase = new CANNON.SAPBroadphase(this.mundoFisica);
        this.mundoFisica.defaultContactMaterial.friction = opcoes.friccaoPadrao || 0.7;
        this.mundoFisica.defaultContactMaterial.restitution = opcoes.restituicaoPadrao || 0.3;
    }

    _configurarControles() {
        this.controlesOrbit = new THREE.OrbitControls(this.editorCamera, this.renderizador.domElement); 
        this.controlesOrbit.enableDamping = true;

        this.controlesTransform = new THREE.TransformControls(this.editorCamera, this.renderizador.domElement); 
        this.cena.add(this.controlesTransform);

        this.controlesTransform.addEventListener('dragging-changed', (event) => {
            this.controlesOrbit.enabled = !event.value;
        });

        this.controlesTransform.addEventListener('objectChange', () => {
            if (this.objetoSelecionadoId && !this.estaRodando) {
                const obj = this.objetosNaCena[this.objetoSelecionadoId];
                if (obj && obj.cannonBody) {
                    obj.cannonBody.position.copy(obj.threeObj.position);
                    obj.cannonBody.quaternion.copy(obj.threeObj.quaternion);
                }
            }
        });
    }

    _configurarEventos() {
        window.addEventListener('resize', () => this._aoRedimensionarJanela());
        this.renderizador.domElement.addEventListener('click', (e) => {
            if (this.controlesTransform.dragging) return; 
            this._manipularSelecao(e);
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && !this.estaRodando) this.removerObjetoSelecionado();
        });
    }
    
    _traduzirCor(nomeCor) {
        const mapaCores = {
            'vermelho': '#ff0000', 'verde': '#00ff00', 'azul': '#0000ff',
            'amarelo': '#ffff00', 'ciano': '#00ffff', 'magenta': '#ff00ff',
            'branco': '#ffffff', 'preto': '#000000', 'cinza': '#808080',
            'laranja': '#ffa500', 'roxo': '#800080', 'marrom': '#a52a2a',
            'prata': '#c0c0c0', 'ouro': '#ffd700', 'bronze': '#cd7f32'
        };
        return mapaCores[String(nomeCor).toLowerCase()] || nomeCor; 
    }
    
    _criarMaterial(opcoes = {}) {
        if (typeof opcoes !== 'object' || opcoes === null) {
            opcoes = {}; 
        }

        let corFinal = this._traduzirCor(opcoes.color || '#ffffff');
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(corFinal),
            roughness: opcoes.roughness !== undefined ? opcoes.roughness : 0.5,
            metalness: opcoes.metalness !== undefined ? opcoes.metalness : 0.5,
        });

        const carregarTextura = (mapType, source) => {
            if (!source) return null;
            let url = '';
            let name = '';

            if (typeof source === 'string') { 
                url = source;
                name = source.substring(source.lastIndexOf('/') + 1);
                const decodedSourceName = this._firebaseDecodeKey(source); 
                const texturePath = ['assets', 'textures', decodedSourceName]; // Caminho completo para a textura
                let textureInFS = this.fileSystemReference;
                for(const part of texturePath) {
                    if (textureInFS && textureInFS[part]) textureInFS = textureInFS[part];
                    else { textureInFS = null; break; }
                }

                if (!source.startsWith('http') && !source.startsWith('data:') && textureInFS && textureInFS.url) {
                    url = textureInFS.url; 
                    name = decodedSourceName; 
                }
            } else if (typeof source === 'object' && source.url) { 
                url = source.url;
                name = source.name;
            } else {
                console.warn(`MotorJM (Aviso Textura): Fonte de textura inválida para '${mapType}'.`);
                return null;
            }

            const textura = this.textureLoader.load(url, (tex) => {
                if (mapType === 'map') tex.encoding = THREE.sRGBEncoding; 
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping; 
                material.needsUpdate = true; 
            }, 
            undefined, 
            (err) => {
                console.error(`MotorJM (Erro Textura): Não foi possível carregar a textura de '${name}' (URL: ${url}) para o mapa '${mapType}'.`, err);
            });
            textura.name = name; 
            return textura;
        };
        
        if (opcoes.map) material.map = carregarTextura('map', opcoes.map);
        if (opcoes.metalnessMap) material.metalnessMap = carregarTextura('metalnessMap', opcoes.metalnessMap);
        if (opcoes.roughnessMap) material.roughnessMap = carregarTextura('roughnessMap', opcoes.roughnessMap);
        
        return material;
    }


    // --- MÉTODOS PÚBLICOS DE CONTROLE DA SIMULAÇÃO ---

    iniciar() {
        this._loopAnimacao();
    }

    play() {
        this.estaRodando = true;
        this.tempEditorCameraTarget.copy(this.controlesOrbit.target);
        if (this.objetoSelecionadoId) {
            const selectedObj = this.objetosNaCena[this.objetoSelecionadoId];
            if (selectedObj && selectedObj.type === 'camera_jogo') {
                this.activeCamera = selectedObj.threeObj;
            } else {
                this.activeCamera = this.editorCamera; 
            }
        } else {
            this.activeCamera = this.editorCamera; 
        }
        this.desselecionarObjeto(); 
        this.controlesOrbit.enabled = false; 
        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.collisionWireframe) obj.collisionWireframe.visible = false;
            if (obj.cameraHelper) obj.cameraHelper.visible = false;
        });
        console.log(`MotorJM (Info): Simulação iniciada. Câmera ativa: ${this.activeCamera === this.editorCamera ? 'Editora' : (this.objetosNaCena[this.objetoSelecionadoId]?.name || 'Câmera de Jogo Selecionada')}.`);
    }

    parar() {
        this.estaRodando = false;
        this.activeCamera = this.editorCamera; 
        this.controlesOrbit.enabled = true; 
        this.controlesOrbit.target.copy(this.tempEditorCameraTarget); 
        console.log("MotorJM (Info): Simulação parada. Resetando objetos...");
        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.cannonBody && obj.estadoInicial) {
                obj.cannonBody.position.copy(obj.estadoInicial.position);
                obj.cannonBody.quaternion.copy(obj.estadoInicial.quaternion);
                obj.cannonBody.velocity.set(0, 0, 0); 
                obj.cannonBody.angularVelocity.set(0, 0, 0); 
                obj.threeObj.position.copy(obj.estadoInicial.position);
                obj.threeObj.quaternion.copy(obj.estadoInicial.quaternion);
            }
        });
        if (this.objetoSelecionadoId) this.selecionarObjeto(this.objetoSelecionadoId); 
    }
    
    _loopAnimacao() {
        requestAnimationFrame(() => this._loopAnimacao()); 
        this.controlesOrbit.update(); 
        if (this.estaRodando) {
            this.mundoFisica.step(1 / 60); 
            Object.values(this.objetosNaCena).forEach(obj => {
                if (obj.cannonBody && obj.cannonBody.mass > 0) {
                    obj.threeObj.position.copy(obj.cannonBody.position);
                    obj.threeObj.quaternion.copy(obj.cannonBody.quaternion);
                }
            });
        }
        this.renderizador.render(this.cena, this.activeCamera); 
    }
    
    
    // --- MÉTODOS DE GERENCIAMENTO DE OBJETOS ---

    adicionarObjeto(id, name, type, opcoes = {}) { 
        if (this.objetosNaCena[id]) {
            console.warn(`MotorJM (Aviso Objeto): Tentativa de adicionar objeto com ID repetido '${id}'.`);
            return null;
        }

        let threeObj = null;
        let collisionWireframe = null; 
        let cameraHelper = null; 

        const pos = new THREE.Vector3(opcoes.position?.x || 0, opcoes.position?.y || 5, opcoes.position?.z || 0);
        const rot = new THREE.Euler(opcoes.rotation?.x || 0, opcoes.rotation?.y || 0, opcoes.rotation?.z || 0);

        if (type === 'camera') {
            const fov = opcoes.fov || 75;
            const near = opcoes.near || 0.1;
            const far = opcoes.far || 1000;
            threeObj = new THREE.PerspectiveCamera(fov, this.container.clientWidth / this.container.clientHeight, near, far);
            threeObj.position.copy(pos);
            threeObj.rotation.copy(rot);
            this.cena.add(threeObj); 

            cameraHelper = new THREE.CameraHelper(threeObj);
            this.cena.add(cameraHelper);
            cameraHelper.visible = false; 
            type = 'camera_jogo'; 

            console.log(`MotorJM (Info Câmera): Câmera de Jogo '${name}' (ID: ${id}) adicionada.`);
            const newObj = { 
                id, name, type, threeObj, cameraHelper,
                estadoInicial: { 
                    position: threeObj.position.clone(),
                    quaternion: threeObj.quaternion.clone(),
                },
            };
            this.objetosNaCena[id] = newObj;
            return newObj;

        } else { 
            let geometry;
            const material = this._criarMaterial(opcoes.material); 

            switch (type) {
                case 'caixa':
                    const s = opcoes.size || { w: 1, h: 1, d: 1 };
                    geometry = new THREE.BoxGeometry(s.w, s.h, s.d);
                    break;
                case 'esfera':
                    const r = opcoes.radius || 1;
                    geometry = new THREE.SphereGeometry(r, 32, 32);
                    break;
                case 'plano':
                    const ps = opcoes.size || { w: 10, d: 10 };
                    geometry = new THREE.PlaneGeometry(ps.w, ps.d);
                    break;
                default:
                    console.error(`MotorJM (Erro Objeto): Tipo de objeto geométrico desconhecido: '${type}'.`);
                    return null;
            }

            threeObj = new THREE.Mesh(geometry, material);
            threeObj.position.copy(pos);
            threeObj.rotation.copy(rot);
            threeObj.castShadow = true; 
            threeObj.receiveShadow = true; 
            if (type === 'plano') {
                threeObj.rotation.x = -Math.PI / 2;
                threeObj.receiveShadow = true; 
                threeObj.castShadow = false; 
            }
            this.cena.add(threeObj); 

            collisionWireframe = new THREE.LineSegments(new THREE.WireframeGeometry(threeObj.geometry), new THREE.LineBasicMaterial({ color: 0xff0000 })); 
            collisionWireframe.visible = false; 
            threeObj.add(collisionWireframe); 

            const initialBodyType = (type === 'plano') ? 'static' : (opcoes.physics?.bodyType ?? 'dynamic'); 
            const initialMass = opcoes.physics?.mass ?? 1;
            const initialFriction = opcoes.physics?.friction ?? 0.7;
            const initialRestitution = opcoes.physics?.restitution ?? 0.3;
            const initialCollisionShape = opcoes.physics?.collisionShape ?? (type === 'caixa' ? 'box' : (type === 'esfera' ? 'sphere' : 'plane')); 
            const initialLinearDamping = opcoes.physics?.linearDamping ?? 0.01;
            const initialAngularDamping = opcoes.physics?.angularDamping ?? 0.01;

            const physicsProperties = {
                bodyType: initialBodyType,
                mass: initialMass,
                friction: initialFriction,
                restitution: initialRestitution,
                collisionShape: initialCollisionShape,
                linearDamping: initialLinearDamping,
                angularDamping: initialAngularDamping,
            };

            const newObj = { 
                id, name, type, threeObj, collisionWireframe, cannonBody: null, 
                estadoInicial: { 
                    position: threeObj.position.clone(),
                    quaternion: threeObj.quaternion.clone(),
                },
                physicsProperties, 
            };
            this.objetosNaCena[id] = newObj;

            this._createOrUpdateCannonBody(newObj);
            console.log(`MotorJM (Info Objeto): Objeto '${name}' (ID: ${id}, Tipo: ${type}) adicionado.`);
            return newObj;
        }
    }

    _createOrUpdateCannonBody(obj) {
        if (!obj.threeObj.isMesh || !obj.physicsProperties) return;

        if (obj.cannonBody) {
            this.mundoFisica.removeBody(obj.cannonBody);
            obj.cannonBody = null;
        }

        let finalMass = 0;
        if (obj.physicsProperties.bodyType === 'dynamic') {
            finalMass = obj.physicsProperties.mass;
            if (finalMass < 0) { 
                finalMass = 1;
                obj.physicsProperties.mass = 1; 
            }
        } else if (obj.physicsProperties.bodyType === 'static') {
            finalMass = 0; 
            obj.physicsProperties.mass = 0; 
        } else { 
            obj.collisionWireframe.material.color.set(this._traduzirCor('vermelho')); 
            obj.collisionWireframe.material.needsUpdate = true;
            return;
        }

        let cannonShape;
        try {
            const geoParams = obj.threeObj.geometry.parameters;
            const threeType = obj.type;

            switch (obj.physicsProperties.collisionShape) {
                case 'box':
                    const boxWidth = (threeType === 'caixa' && geoParams.width !== undefined) ? geoParams.width : 1;
                    const boxHeight = (threeType === 'caixa' && geoParams.height !== undefined) ? geoParams.height : 1;
                    const boxDepth = (threeType === 'caixa' && geoParams.depth !== undefined) ? geoParams.depth : 1;
                    cannonShape = new CANNON.Box(new CANNON.Vec3(boxWidth / 2, boxHeight / 2, boxDepth / 2));
                    break;
                case 'sphere':
                    const sphereRadius = (threeType === 'esfera' && geoParams.radius !== undefined) ? geoParams.radius : 1;
                    cannonShape = new CANNON.Sphere(sphereRadius);
                    break;
                case 'plane':
                    cannonShape = new CANNON.Plane();
                    break;
                default:
                    console.error(`MotorJM (Erro Física): Forma de colisão desconhecida: '${obj.physicsProperties.collisionShape}' para o objeto '${obj.id}'.`);
                    obj.cannonBody = null; 
                    this._atualizarCorMalhaColisao(obj.id); 
                    return;
            }

            obj.cannonBody = new CANNON.Body({
                mass: finalMass,
                position: new CANNON.Vec3().copy(obj.threeObj.position),
                linearDamping: obj.physicsProperties.linearDamping,
                angularDamping: obj.physicsProperties.angularDamping,
            });
            obj.cannonBody.addShape(cannonShape); 
            obj.cannonBody.quaternion.copy(obj.threeObj.quaternion);

            const bodyMaterial = new CANNON.Material({ 
                friction: obj.physicsProperties.friction, 
                restitution: obj.physicsProperties.restitution 
            });
            obj.cannonBody.material = bodyMaterial;

            this.mundoFisica.addBody(obj.cannonBody);
            this._atualizarCorMalhaColisao(obj.id); 
        } catch (e) {
            console.error(`MotorJM (Erro Física): Falha ao criar/recriar corpo físico para '${obj.id}':`, e);
            obj.cannonBody = null; 
            this._atualizarCorMalhaColisao(obj.id); 
        }
    }

    _atualizarCorMalhaColisao(id) {
        const obj = this.objetosNaCena[id];
        if (!obj || !obj.collisionWireframe) return;

        if (obj.physicsProperties?.bodyType !== 'none') { 
            obj.collisionWireframe.material.color.set(this._traduzirCor('verde'));
        } else {
            obj.collisionWireframe.material.color.set(this._traduzirCor('vermelho'));
        }
        obj.collisionWireframe.material.needsUpdate = true; 
    }


    adicionarLuz(id, name, opcoes) {
        if (this.objetosNaCena[id]) {
             console.warn(`MotorJM (Aviso Luz): Tentativa de adicionar luz com ID repetido '${id}'.`);
            return;
        }
        let luz;
        const corLuz = this._traduzirCor(opcoes.color || '#ffffff');
        const intensidadeLuz = opcoes.intensity !== undefined ? opcoes.intensity : 1;

        switch (opcoes.type) {
            case 'ambiente': 
                luz = new THREE.AmbientLight(corLuz, intensidadeLuz); 
                break;
            case 'direcional': 
                luz = new THREE.DirectionalLight(corLuz, intensidadeLuz); 
                if (opcoes.position) luz.position.copy(opcoes.position); 
                if (opcoes.castShadow) { 
                    luz.castShadow = true; 
                    luz.shadow.mapSize.set(2048, 2048); 
                    luz.shadow.camera.near = 0.5;
                    luz.shadow.camera.far = 50;
                    luz.shadow.camera.left = -20;
                    luz.shadow.camera.right = 20;
                    luz.shadow.camera.top = 20;
                    luz.shadow.camera.bottom = -20;
                } 
                break;
            case 'ponto':
                 luz = new THREE.PointLight(corLuz, intensidadeLuz, opcoes.distance || 100, opcoes.decay || 2);
                 if (opcoes.position) luz.position.copy(opcoes.position);
                 if (opcoes.castShadow) luz.castShadow = true;
                break;
            default: 
                console.error(`MotorJM (Erro Luz): Tipo de luz desconhecido: '${opcoes.type}'.`); 
                return;
        }
        this.cena.add(luz); 
        this.objetosNaCena[id] = { id, name, type: `luz_${opcoes.type}`, threeObj: luz };
        console.log(`MotorJM (Info Luz): Luz '${name}' (ID: ${id}, Tipo: ${opcoes.type}) adicionada.`);
    }

    removerObjeto(id) {
        const obj = this.objetosNaCena[id];
        if (!obj) {
            console.warn(`MotorJM (Aviso Remoção): Objeto com ID '${id}' não encontrado para remoção.`);
            return;
        }
        
        if (id === this.objetoSelecionadoId) {
            this.desselecionarObjeto();
        }

        this.cena.remove(obj.threeObj); 
        
        if (obj.threeObj.isMesh) {
            obj.threeObj.geometry.dispose();
            if (obj.collisionWireframe) {
                obj.threeObj.remove(obj.collisionWireframe); 
                obj.collisionWireframe.geometry.dispose();
                obj.collisionWireframe.material.dispose();
            }

            if (obj.threeObj.material.isMaterial) {
                if (obj.threeObj.material.map) obj.threeObj.material.map.dispose();
                if (obj.threeObj.material.metalnessMap) obj.threeObj.material.metalnessMap.dispose();
                if (obj.threeObj.material.roughnessMap) obj.threeObj.material.roughnessMap.dispose();
                obj.threeObj.material.dispose();
            }
        } else if (obj.type === 'camera_jogo') { 
            if (obj.cameraHelper) {
                this.cena.remove(obj.cameraHelper);
                if (obj.cameraHelper.material) obj.cameraHelper.material.dispose();
                if (obj.cameraHelper.geometry) obj.cameraHelper.geometry.dispose();
            }
        }
        
        if (obj.cannonBody) {
            this.mundoFisica.removeBody(obj.cannonBody);
        }
        
        delete this.objetosNaCena[id]; 
        console.log(`MotorJM (Info Remoção): Objeto '${obj.name || obj.id}' removido com sucesso.`);
    }
    
    removerObjetoSelecionado() { 
        if (this.objetoSelecionadoId) {
            this.removerObjeto(this.objetoSelecionadoId);
        } else {
            console.warn("MotorJM (Aviso Remoção): Nenhum objeto selecionado para remover.");
        }
    }
    
    // MODIFICADO: Limpa a cena completamente, incluindo luzes padrão
    limparCenaTotalmente() {
        console.log("MotorJM (Info Limpeza): Limpando cena totalmente...");
        // Remove todos os objetos, incluindo os "_padrao"
        const idsParaRemover = Object.keys(this.objetosNaCena);
        idsParaRemover.forEach(id => this.removerObjeto(id));
        
        // Reseta configurações de fundo e neblina
        this.cena.background = new THREE.Color(this.cena._backgroundConfig.color); // Usa cor padrão inicial
        if (this.cena.environment) {
            this.cena.environment.dispose();
            this.cena.environment = null;
        }
        this.cena._backgroundConfig.environmentMapName = 'Nenhuma';
        this.cena.fog = null;

        // Limpa o mundo da física (opcional, mas bom para um reset completo)
        while(this.mundoFisica.bodies.length > 0){
            this.mundoFisica.removeBody(this.mundoFisica.bodies[0]);
        }
        console.log(`MotorJM (Info Limpeza): Cena totalmente limpa. ${idsParaRemover.length} objetos removidos.`);
    }

    // Mantém a função `limparCena` original para o "Gerar Script" que não deve remover luzes padrão
    limparCena() { 
        const idsParaRemover = Object.keys(this.objetosNaCena).filter(id => !id.endsWith('_padrao_removivel'));
        if (idsParaRemover.length === 0 && !Object.keys(this.objetosNaCena).some(id => id.endsWith('_padrao_removivel'))) {
           // console.log("MotorJM (Info Limpeza): Nenhuns objetos adicionados pelo usuário para remover.");
        }
        idsParaRemover.forEach(id => this.removerObjeto(id));
        // console.log(`MotorJM (Info Limpeza): Objetos do usuário limpos. ${idsParaRemover.length} objetos removidos.`);
    }


    // --- MÉTODOS DE MANIPULAÇÃO E INTERAÇÃO ---

    selecionarObjeto(id) {
        if (!id || !this.objetosNaCena[id]) {
            console.warn(`MotorJM (Aviso Seleção): Objeto com ID '${id}' não encontrado para seleção.`);
            return;
        }
        if (this.estaRodando) {
            console.warn("MotorJM (Aviso Seleção): Não é possível selecionar objetos enquanto a simulação está rodando.");
            return;
        }

        if (this.objetoSelecionadoId && this.objetoSelecionadoId !== id) {
             this.desselecionarObjeto();
        }

        this.objetoSelecionadoId = id;
        this.controlesTransform.attach(this.objetosNaCena[id].threeObj); 
        
        const obj = this.objetosNaCena[id];
        if (obj.collisionWireframe) {
            obj.collisionWireframe.visible = true;
            this._atualizarCorMalhaColisao(id); 
        }
        if (obj.cameraHelper) {
            obj.cameraHelper.visible = true;
        }

        window.dispatchEvent(new CustomEvent('objetoSelecionado', { detail: { id } }));
        console.log(`MotorJM (Info Seleção): Objeto '${this.objetosNaCena[id].name || id}' selecionado.`);
    }

    desselecionarObjeto() {
        if (this.objetoSelecionadoId) {
            const obj = this.objetosNaCena[this.objetoSelecionadoId];
            if (obj) { 
                if (obj.collisionWireframe) {
                    obj.collisionWireframe.visible = false;
                }
                if (obj.cameraHelper) {
                    obj.cameraHelper.visible = false;
                }
            }

            this.controlesTransform.detach(); 
            console.log(`MotorJM (Info Seleção): Objeto '${obj?.name || this.objetoSelecionadoId}' desselecionado.`);
            this.objetoSelecionadoId = null; 
            window.dispatchEvent(new CustomEvent('objetoDesselecionado'));
        }
    }
    
    atualizarPropriedadeObjeto(id, prop, value) {
        const obj = this.objetosNaCena[id];
        if (!obj) {
            console.warn(`MotorJM (Aviso Atualização): Objeto com ID '${id}' não encontrado para atualização da propriedade '${prop}'.`);
            return;
        }
        
        if (prop.startsWith('physics.')) {
            const physicsKey = prop.split('.')[1];
            if (!obj.physicsProperties || !obj.physicsProperties.hasOwnProperty(physicsKey)) {
                console.error(`MotorJM (Erro Atualização): Propriedade de física desconhecida '${prop}' para o objeto '${id}'.`);
                return;
            }

            obj.physicsProperties[physicsKey] = value;
            console.log(`MotorJM (Info Atualização): Propriedade de física '${prop}' de '${id}' atualizada para '${value}'.`);

            if (physicsKey === 'bodyType' || physicsKey === 'collisionShape') {
                this._createOrUpdateCannonBody(obj);
            } else if (obj.cannonBody) {
                if (physicsKey === 'mass') {
                    obj.cannonBody.mass = value;
                    obj.cannonBody.updateMassProperties(); 
                } else if (physicsKey === 'linearDamping') {
                    obj.cannonBody.linearDamping = value;
                } else if (physicsKey === 'angularDamping') {
                    obj.cannonBody.angularDamping = value;
                } else if (obj.cannonBody.material) {
                    obj.cannonBody.material[physicsKey] = value; 
                } else { 
                    obj.cannonBody.material = new CANNON.Material({ 
                        friction: obj.physicsProperties.friction, 
                        restitution: obj.physicsProperties.restitution 
                    });
                }
                if (obj.collisionWireframe && this.objetoSelecionadoId === id) {
                    obj.collisionWireframe.visible = true;
                    this._atualizarCorMalhaColisao(id);
                }
            }
            return; 
        } 
        else if (obj.type === 'camera_jogo' && ['fov', 'near', 'far'].includes(prop)) {
            if (obj.threeObj[prop] !== undefined) {
                obj.threeObj[prop] = value;
                obj.threeObj.updateProjectionMatrix(); 
                if (obj.cameraHelper) {
                    obj.cameraHelper.update();
                }
                console.log(`MotorJM (Info Atualização): Propriedade de câmera '${prop}' de '${id}' atualizada para '${value}'.`);
            } else {
                console.error(`MotorJM (Erro Atualização): Propriedade de câmera desconhecida '${prop}' para o objeto '${id}'.`);
            }
            return; 
        }

        const keys = prop.split('.');
        let target = obj.threeObj; 
        
        for (let i = 0; i < keys.length - 1; i++) { 
            if (target[keys[i]] === undefined) {
                console.error(`MotorJM (Erro Atualização): Propriedade aninhada '${keys[i]}' não encontrada no caminho '${prop}' para o objeto '${id}'.`);
                return;
            }
            target = target[keys[i]]; 
        }
        const finalKey = keys[keys.length - 1];

        if (finalKey === 'color') {
            try {
                target.color.set(this._traduzirCor(value));
                console.log(`MotorJM (Info Atualização): Cor de '${id}' atualizada para '${value}'.`);
            } catch (e) {
                console.error(`MotorJM (Erro Atualização): Valor de cor inválido '${value}' para o objeto '${id}'.`, e);
            }
        } else if (['map', 'metalnessMap', 'roughnessMap'].includes(finalKey)) {
            if (typeof value === 'object' && value !== null && value.url) {
                const textura = this.textureLoader.load(value.url, (tex) => {
                    if (finalKey === 'map') tex.encoding = THREE.sRGBEncoding;
                    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                    target.needsUpdate = true;
                }, undefined, (err) => {
                    console.error(`MotorJM (Erro Textura): Falha ao carregar textura para '${finalKey}' de '${value.url}' no objeto '${id}'.`, err);
                });
                textura.name = value.name;
                if (target[finalKey]) { target[finalKey].dispose(); }
                target[finalKey] = textura;
                console.log(`MotorJM (Info Atualização): Textura '${value.name}' carregada para '${finalKey}' do objeto '${id}'.`);
            } else if (value === null) { 
                 if (target[finalKey]) { target[finalKey].dispose(); target[finalKey] = null; console.log(`MotorJM (Info Atualização): Textura de '${finalKey}' removida do objeto '${id}'.`); }
            } else {
                console.error(`MotorJM (Erro Atualização): Valor de textura inválido para '${finalKey}' no objeto '${id}'.`);
            }
        } else {
            if (target[finalKey] === undefined) {
                console.error(`MotorJM (Erro Atualização): Propriedade '${finalKey}' não existe para o objeto '${id}' no caminho '${prop}'.`);
                return;
            }
            target[finalKey] = value;
            console.log(`MotorJM (Info Atualização): Propriedade '${prop}' de '${id}' atualizada para '${value}'.`);
        }

        if (prop.startsWith('position') || prop.startsWith('rotation')) {
             if (obj.cannonBody) {
                obj.cannonBody.position.copy(obj.threeObj.position);
                obj.cannonBody.quaternion.copy(obj.threeObj.quaternion);
                obj.cannonBody.velocity.set(0, 0, 0);
                obj.cannonBody.angularVelocity.set(0, 0, 0);
             }
             if (obj.estadoInicial) {
                 obj.estadoInicial.position.copy(obj.threeObj.position);
                 obj.estadoInicial.quaternion.copy(obj.threeObj.quaternion);
             }
        }
        if (prop.startsWith('material.') && obj.threeObj.isMesh) {
            obj.threeObj.material.needsUpdate = true;
        }
    }
    
    // --- MÉTODOS GETTERS E DE CONFIGURAÇÃO DA CENA ---
    
    getObjetosNaCena() { return this.objetosNaCena; }
    getControlesTransform() { return this.controlesTransform; }
    
    configurarNeblina(opcoes) { 
        if (opcoes.enabled) {
            const corNeblina = this._traduzirCor(opcoes.color || '#87ceeb');
            this.cena.fog = new THREE.Fog(corNeblina, opcoes.near || 20, opcoes.far || 100);
            console.log(`MotorJM (Info Cena): Neblina habilitada. Cor: ${corNeblina}, Perto: ${opcoes.near}, Longe: ${opcoes.far}.`);
        } else {
            this.cena.fog = null;
            console.log("MotorJM (Info Cena): Neblina desabilitada.");
        }
    }
    
    configurarGravidade(x, y, z) { 
        this.mundoFisica.gravity.set(x, y, z);
        console.log(`MotorJM (Info Cena): Gravidade configurada para X:${x}, Y:${y}, Z:${z}.`);
    }

    configurarFundoCena(opcoes = {}) {
        if (opcoes.color !== undefined) {
            this.cena.background = new THREE.Color(this._traduzirCor(opcoes.color));
            this.cena._backgroundConfig.color = opcoes.color;
            console.log(`MotorJM (Info Cena): Cor de fundo alterada para '${opcoes.color}'.`);
        }

        if (this.cena.environment) {
            this.cena.environment.dispose();
            this.cena.environment = null;
        }

        if (opcoes.environmentMap !== undefined && opcoes.environmentMap !== null) {
            const source = opcoes.environmentMap; 
            let fileUrl = '';
            let fileName = '';

            if (typeof source === 'string') { 
                fileUrl = source; // Assume que é uma Data URL
                fileName = `(Embedded) ${source.substring(source.lastIndexOf('/') + 1, source.lastIndexOf(';')) || source.substring(0,30)+"..."}`;
            } else if (source instanceof File) { 
                fileUrl = URL.createObjectURL(source);
                fileName = source.name;
            } else if (typeof source === 'object' && source.url) { 
                fileUrl = source.url;
                fileName = source.name;
            } else {
                console.warn(`MotorJM (Aviso Cena): Fonte de imagem ambiente inválida. Ignorando.`);
                this.cena._backgroundConfig.environmentMapName = 'Nenhuma';
                return;
            }

            this.cena._backgroundConfig.environmentMapName = fileName; 

            if (fileName.toLowerCase().endsWith('.hdr') || fileUrl.startsWith('data:image/vnd.radiance')) {
                this.rgbeLoader.load(fileUrl, (texture) => {
                    const pmremGenerator = new THREE.PMREMGenerator(this.renderizador);
                    pmremGenerator.compileEquirectangularShader();
                    const envMap = pmremGenerator.fromEquirectangular(texture).texture;
                    
                    this.cena.environment = envMap; 
                    this.cena.background = envMap; 
                    texture.dispose();
                    pmremGenerator.dispose();
                    if (source instanceof File) URL.revokeObjectURL(fileUrl); 
                    console.log(`MotorJM (Info Cena): Imagem ambiente HDR '${fileName}' carregada.`);
                }, undefined, (err) => {
                    console.error(`MotorJM (Erro Cena): Falha ao carregar imagem ambiente HDR '${fileName}':`, err);
                    if (source instanceof File) URL.revokeObjectURL(fileUrl);
                });
            } else if (fileName.match(/\.(png|jpg|jpeg)$/i) || fileUrl.startsWith('data:image/')) { 
                this.textureLoader.load(fileUrl, (texture) => {
                    const pmremGenerator = new THREE.PMREMGenerator(this.renderizador);
                    pmremGenerator.compileEquirectangularShader();
                    const envMap = pmremGenerator.fromEquirectangular(texture).texture;

                    this.cena.environment = envMap;
                    this.cena.background = new THREE.CubeTextureLoader().load([
                        fileUrl, fileUrl, fileUrl, fileUrl, fileUrl, fileUrl 
                    ]); 
                    texture.dispose();
                    pmremGenerator.dispose();
                    if (source instanceof File) URL.revokeObjectURL(fileUrl);
                    console.log(`MotorJM (Info Cena): Imagem ambiente '${fileName}' carregada.`);
                }, undefined, (err) => {
                    console.error(`MotorJM (Erro Cena): Falha ao carregar imagem ambiente '${fileName}':`, err);
                    if (source instanceof File) URL.revokeObjectURL(fileUrl);
                });
            } else {
                console.warn(`MotorJM (Aviso Cena): Tipo de arquivo para imagem ambiente não suportado: '${fileName}'.`);
                if (source instanceof File) URL.revokeObjectURL(fileUrl);
            }
        } else if (opcoes.environmentMap === null) { 
            this.cena.environment = null;
            this.cena.background = new THREE.Color(this._traduzirCor(opcoes.color || this.cena._backgroundConfig.color || '#1a1a1a')); 
            this.cena._backgroundConfig.environmentMapName = 'Nenhuma';
            console.log("MotorJM (Info Cena): Imagem ambiente removida.");
        }
    }

    aplicarConfiguracoesDeRenderizacao(opcoes = {}) {
        if (opcoes.hasOwnProperty('sombrasHabilitadas')) {
            this.renderizador.shadowMap.enabled = opcoes.sombrasHabilitadas;
        }
        if (opcoes.hasOwnProperty('tipoSombra')) {
            switch (opcoes.tipoSombra) {
                case 'BasicShadowMap': this.renderizador.shadowMap.type = THREE.BasicShadowMap; break;
                case 'VSMShadowMap': this.renderizador.shadowMap.type = THREE.VSMShadowMap; break;
                case 'PCFSoftShadowMap':
                default: this.renderizador.shadowMap.type = THREE.PCFSoftShadowMap; break;
            }
        }
        if (opcoes.hasOwnProperty('toneMappingHabilitado')) {
            this.renderizador.toneMapping = opcoes.toneMappingHabilitado ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
        }
        if (opcoes.hasOwnProperty('exposicaoToneMapping')) {
            this.renderizador.toneMappingExposure = opcoes.exposicaoToneMapping;
        }
        if (opcoes.hasOwnProperty('pixelRatio')) {
            this.renderizador.setPixelRatio(opcoes.pixelRatio);
        }
        
        if (opcoes.hasOwnProperty('shadowMapSize')) {
            Object.values(this.objetosNaCena).forEach(obj => {
                if (obj.threeObj.isDirectionalLight && obj.threeObj.shadow) {
                    obj.threeObj.shadow.mapSize.width = opcoes.shadowMapSize;
                    obj.threeObj.shadow.mapSize.height = opcoes.shadowMapSize;
                    obj.threeObj.shadow.map = null; 
                    obj.threeObj.shadow.needsUpdate = true; 
                }
            });
        }
        console.log("MotorJM (Info Gráficos): Configurações de renderização aplicadas.");
    }

    aplicarPresetQualidade(preset) {
        let settings = {};
        switch (preset) {
            case 'baixa':
                settings = {
                    sombrasHabilitadas: true, tipoSombra: 'BasicShadowMap', shadowMapSize: 512,
                    toneMappingHabilitado: true, exposicaoToneMapping: 0.8,
                    pixelRatio: 0.75
                };
                break;
            case 'media':
                settings = {
                    sombrasHabilitadas: true, tipoSombra: 'PCFSoftShadowMap', shadowMapSize: 1024,
                    toneMappingHabilitado: true, exposicaoToneMapping: 1.0,
                    pixelRatio: 1.0
                };
                break;
            case 'alta':
                settings = {
                    sombrasHabilitadas: true, tipoSombra: 'PCFSoftShadowMap', shadowMapSize: 2048,
                    toneMappingHabilitado: true, exposicaoToneMapping: 1.2,
                    pixelRatio: window.devicePixelRatio || 1 
                };
                break;
            default:
                console.warn(`MotorJM (Aviso Gráficos): Preset de qualidade desconhecido: '${preset}'.`);
                return {};
        }
        this.aplicarConfiguracoesDeRenderizacao(settings); 
        console.log(`MotorJM (Info Gráficos): Preset de qualidade '${preset}' aplicado.`);
        return settings; 
    }

    _aoRedimensionarJanela() {
        this.editorCamera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.editorCamera.updateProjectionMatrix();

        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.type === 'camera_jogo' && obj.threeObj.isPerspectiveCamera) {
                obj.threeObj.aspect = this.container.clientWidth / this.container.clientHeight;
                obj.threeObj.updateProjectionMatrix();
                if (obj.cameraHelper) { 
                    obj.cameraHelper.update();
                }
            }
        });

        this.renderizador.setSize(this.container.clientWidth, this.container.clientHeight);
        console.log("MotorJM (Info): Janela redimensionada. Câmeras e renderizador atualizados.");
    }
    
    _manipularSelecao(event) {
        if (this.estaRodando || this.controlesTransform.dragging) return;

        const rect = this.renderizador.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.editorCamera); 

        const selectableObjects = [];
        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.threeObj.isMesh) {
                selectableObjects.push(obj.threeObj);
            } else if (obj.type === 'camera_jogo' && obj.cameraHelper) {
                selectableObjects.push(obj.cameraHelper); 
            }
        });

        const intersects = this.raycaster.intersectObjects(selectableObjects, true); 

        if (intersects.length > 0) {
            let selectedManagedObj = null; 
            let selectedId = null;

            for (const intersect of intersects) {
                let currentThreeObject = intersect.object;
                while (currentThreeObject) {
                    selectedId = Object.keys(this.objetosNaCena).find(id => {
                        const obj = this.objetosNaCena[id];
                        return obj.threeObj === currentThreeObject || obj.cameraHelper === currentThreeObject;
                    });
                    
                    if (selectedId) {
                        selectedManagedObj = this.objetosNaCena[selectedId];
                        break;
                    }
                    currentThreeObject = currentThreeObject.parent;
                }
                if (selectedManagedObj) break;
            }
            
            if (selectedId) {
                this.selecionarObjeto(selectedId);
            } else {
                console.warn("MotorJM (Aviso Seleção): Objeto Three.js intersectado não possui um ID gerenciado pelo motor.");
            }
        } else {
            this.desselecionarObjeto(); 
        }
    }

    executeScript(code, name = '(script)') {
        try {
            // Ao executar um script (de um mundo), sempre adiciona as luzes padrão DEPOIS,
            // para que o script do mundo possa definir suas próprias luzes.
            new Function('motor', code)(this); 
            this._configurarIluminacaoPadrao(); // Garante que haja luzes se o script do mundo não adicionar
            console.log(`MotorJM (Info Script): Script '${name}' executado com sucesso.`);
        } catch (e) {
            console.error(`MotorJM (Erro Script): Erro ao executar script '${name}':`, e);
            throw e; 
        }
    }
    
    // --- FUNÇÕES AUXILIARES DE SALVAMENTO/CARREGAMENTO DE PROJETO ---

    _getSceneSettings() {
        const renderer = this.renderizador;
        const currentLight = Object.values(this.objetosNaCena).find(o => o.threeObj.isDirectionalLight)?.threeObj;
        const currentShadowMapSize = currentLight?.shadow?.mapSize.width || 1024;

        return {
            gravity: this.mundoFisica.gravity.toArray(),
            fogConfig: this.cena.fog ? {
                enabled: true,
                color: `#${this.cena.fog.color.getHexString()}`,
                near: this.cena.fog.near,
                far: this.cena.fog.far
            } : { enabled: false },
            backgroundConfig: {
                color: `#${this.cena.background?.getHexString() || '1a1a1a'}`,
                environmentMapName: this.cena._backgroundConfig.environmentMapName 
            },
            renderSettings: {
                sombrasHabilitadas: renderer.shadowMap.enabled,
                tipoSombra: Object.keys(THREE).find(key => THREE[key] === renderer.shadowMap.type) || 'PCFSoftShadowMap',
                toneMappingHabilitado: renderer.toneMapping !== THREE.NoToneMapping,
                exposicaoToneMapping: parseFloat(renderer.toneMappingExposure.toFixed(2)),
                pixelRatio: parseFloat(renderer.getPixelRatio().toFixed(2)),
                shadowMapSize: currentShadowMapSize
            }
        };
    }

    gerarScriptDaCena() { 
        let script = `// Script gerado pelo Motor Monkey Editor\n// Este script recria os objetos e configurações da cena.\n// Para um projeto completo (incluindo arquivos), use a função de "Salvar Nuvem".\n\n`;
        script += `motor.limparCenaTotalmente();\n\n`; // Limpa completamente para o script gerado
        
        const sceneSettings = this._getSceneSettings();

        const g = sceneSettings.gravity;
        script += `motor.configurarGravidade(${g[0].toFixed(2)}, ${g[1].toFixed(2)}, ${g[2].toFixed(2)});\n`;
        
        if (sceneSettings.fogConfig.enabled) {
            const fog = sceneSettings.fogConfig;
            script += `motor.configurarNeblina({ enabled: true, color: '${fog.color}', near: ${fog.near.toFixed(2)}, far: ${fog.far.toFixed(2)} });\n`;
        } else {
            script += `motor.configurarNeblina({ enabled: false });\n`;
        }

        const backgroundOpts = sceneSettings.backgroundConfig;
        let envMapRef = '';
        if(backgroundOpts.environmentMapName && backgroundOpts.environmentMapName !== 'Nenhuma') {
            envMapRef = `, environmentMap: '${backgroundOpts.environmentMapName}'`;
        }
        script += `motor.configurarFundoCena({ color: '${backgroundOpts.color}'${envMapRef} });\n`;

        const renderSettings = sceneSettings.renderSettings;
        script += `motor.aplicarConfiguracoesDeRenderizacao(${JSON.stringify(renderSettings, null, 2)});\n\n`;
        
        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.id.endsWith('_padrao_removivel')) return; // Não inclui luzes padrão removíveis no script gerado

            const pos = obj.threeObj.position;
            const rot = obj.threeObj.rotation; 

            let opts = {
                position: { 
                    x: parseFloat(pos.x.toFixed(2)), 
                    y: parseFloat(pos.y.toFixed(2)), 
                    z: parseFloat(pos.z.toFixed(2)) 
                },
                rotation: { 
                    x: parseFloat(rot.x.toFixed(2)), 
                    y: parseFloat(rot.y.toFixed(2)), 
                    z: parseFloat(rot.z.toFixed(2)) 
                },
            };

            if (obj.type.startsWith('luz_')) {
                const luz = obj.threeObj;
                opts.type = obj.type.replace('luz_', ''); 
                opts.color = `#${luz.color.getHexString()}`, 
                opts.intensity = parseFloat(luz.intensity.toFixed(2));
                
                if (luz.castShadow !== undefined) opts.castShadow = luz.castShadow;
                if (luz.distance !== undefined) opts.distance = parseFloat(luz.distance.toFixed(2));
                if (luz.decay !== undefined) opts.decay = parseFloat(luz.decay.toFixed(2));

                script += `motor.adicionarLuz('${obj.id}', '${obj.name}', ${JSON.stringify(opts, null, 2)});\n\n`;
            } else if (obj.type === 'camera_jogo') {
                opts.fov = parseFloat(obj.threeObj.fov.toFixed(2));
                opts.near = parseFloat(obj.threeObj.near.toFixed(2));
                opts.far = parseFloat(obj.threeObj.far.toFixed(2));
                script += `motor.adicionarObjeto('${obj.id}', '${obj.name}', 'camera', ${JSON.stringify(opts, null, 2)});\n\n`;

            } else {
                if(obj.physicsProperties) {
                    opts.physics = { 
                        bodyType: obj.physicsProperties.bodyType,
                        mass: parseFloat(obj.physicsProperties.mass.toFixed(2)),
                        friction: parseFloat(obj.physicsProperties.friction.toFixed(2)),
                        restitution: parseFloat(obj.physicsProperties.restitution.toFixed(2)),
                        collisionShape: obj.physicsProperties.collisionShape, 
                        linearDamping: parseFloat(obj.physicsProperties.linearDamping.toFixed(2)), 
                        angularDamping: parseFloat(obj.physicsProperties.angularDamping.toFixed(2)), 
                    };
                }

                if (obj.threeObj.isMesh) {
                    const mat = obj.threeObj.material;
                    opts.material = {
                        color: `#${mat.color.getHexString()}`, 
                        roughness: parseFloat(mat.roughness.toFixed(2)),
                        metalness: parseFloat(mat.metalness.toFixed(2))
                    };
                    if (mat.map && mat.map.name && !mat.map.name.startsWith('data:')) opts.material.map = mat.map.name;
                    if (mat.roughnessMap && mat.roughnessMap.name && !mat.roughnessMap.name.startsWith('data:')) opts.material.roughnessMap = mat.roughnessMap.name;
                    if (mat.metalnessMap && mat.metalnessMap.name && !mat.metalnessMap.name.startsWith('data:')) opts.material.metalnessMap = mat.metalnessMap.name;
                }

                switch(obj.type) {
                    case 'caixa': 
                        const geoParamsBox = obj.threeObj.geometry.parameters;
                        opts.size = { 
                            w: parseFloat(geoParamsBox.width.toFixed(2)), 
                            h: parseFloat(geoParamsBox.height.toFixed(2)), 
                            d: parseFloat(geoParamsBox.depth.toFixed(2)) 
                        }; 
                        break;
                    case 'esfera': 
                        const geoParamsSphere = obj.threeObj.geometry.parameters;
                        opts.radius = parseFloat(geoParamsSphere.radius.toFixed(2)); 
                        break;
                    case 'plano': 
                        const geoParamsPlane = obj.threeObj.geometry.parameters;
                        opts.size = { 
                            w: parseFloat(geoParamsPlane.width.toFixed(2)), 
                            d: parseFloat(geoParamsPlane.height.toFixed(2)) 
                        }; 
                        break;
                }
                script += `motor.adicionarObjeto('${obj.id}', '${obj.name}', '${obj.type}', ${JSON.stringify(opts, null, 2)});\n\n`;
            }
        });
        console.log("MotorJM (Info Script): Script da cena gerado com sucesso.");
        return script;
    }

    _firebaseEncodeKey(key) {
        if (typeof key !== 'string') return key;
        return key
            .replace(/\./g, '_DOT_')
            .replace(/\#/g, '_HASH_')
            .replace(/\$/g, '_DOLLAR_')
            .replace(/\//g, '_SLASH_') 
            .replace(/\[/g, '_LBRACKET_')
            .replace(/\]/g, '_RBRACKET_');
    }

    _firebaseDecodeKey(encodedKey) {
        if (typeof encodedKey !== 'string') return encodedKey;
        return encodedKey
            .replace(/_DOT_/g, '.')
            .replace(/_HASH_/g, '#')
            .replace(/_DOLLAR_/g, '$')
            .replace(/_SLASH_/g, '/')
            .replace(/_LBRACKET_/g, '[')
            .replace(/_RBRACKET_/g, ']');
    }

    gerarDadosDoProjeto(activeWorldScriptContent, fileSystemData, forFirebase = false, activeWorldPathArray = []) {
        const encodeString = (str) => str ? btoa(encodeURIComponent(str)) : null;

        const processFileSystem = (node, encodeKeys) => {
            const processedNode = {};
            for (let key in node) {
                if (node.hasOwnProperty(key)) {
                    const value = node[key];
                    const newKey = encodeKeys ? this._firebaseEncodeKey(key) : key;

                    if (typeof value === 'object' && value !== null && !value.type) { 
                        processedNode[newKey] = processFileSystem(value, encodeKeys);
                    } else if (typeof value === 'object' && value !== null && value.type) { 
                        processedNode[newKey] = { ...value }; 
                        if (processedNode[newKey].url && typeof processedNode[newKey].url === 'string') { 
                            processedNode[newKey].url = encodeString(processedNode[newKey].url); 
                        }
                        if (processedNode[newKey].content && typeof processedNode[newKey].content === 'string') {
                            processedNode[newKey].content = encodeString(processedNode[newKey].content); 
                        }
                    } else { 
                        processedNode[newKey] = value;
                    }
                }
            }
            return processedNode;
        };
        
        // Garante que as pastas padrão existam no fileSystemData antes de processar
        if (!fileSystemData.assets) fileSystemData.assets = {};
        if (!fileSystemData.assets.mundos) fileSystemData.assets.mundos = {};
        if (!fileSystemData.assets.scripts) fileSystemData.assets.scripts = {};
        if (!fileSystemData.assets.textures) fileSystemData.assets.textures = {};

        // Assegura que o script do mundo ativo esteja no fileSystem ANTES de serializar
        const activeWorldFileName = activeWorldPathArray.length > 0 ? activeWorldPathArray[activeWorldPathArray.length - 1] : 'mundo_padrao.js';
        const activeWorldKeyForFs = forFirebase ? this._firebaseEncodeKey(activeWorldFileName) : activeWorldFileName;
        
        let mundosFolder = fileSystemData.assets.mundos;
        if (forFirebase) { // Para firebase, todas as chaves na hierarquia são codificadas
             let currentFsLevel = fileSystemData;
             activeWorldPathArray.slice(0, -1).forEach(part => {
                 const encodedPart = this._firebaseEncodeKey(part);
                 if (!currentFsLevel[encodedPart]) currentFsLevel[encodedPart] = {};
                 currentFsLevel = currentFsLevel[encodedPart];
             });
             mundosFolder = currentFsLevel;
        }


        if (!mundosFolder[activeWorldKeyForFs] || typeof mundosFolder[activeWorldKeyForFs] !== 'object') {
             mundosFolder[activeWorldKeyForFs] = {};
        }
        mundosFolder[activeWorldKeyForFs].type = 'script';
        mundosFolder[activeWorldKeyForFs].content = activeWorldScriptContent; // Conteúdo RAW será codificado por processFileSystem
        // A Data URL não precisa ser gerada aqui, pois processFileSystem cuidará disso.


        const processedFileSystem = processFileSystem(JSON.parse(JSON.stringify(fileSystemData)), forFirebase);

        const projectData = {
            // sceneScript: encodeString(activeWorldScriptContent), // Script do mundo ativo está no fileSystem agora
            fileSystem: processedFileSystem, 
            sceneSettings: this._getSceneSettings(), 
            activeWorldPath: activeWorldPathArray.map(p => forFirebase ? this._firebaseEncodeKey(p) : p) 
        };

        if (forFirebase) { 
            return projectData; 
        } else { 
            let jsonString = JSON.stringify(projectData, null, 2);
            jsonString = jsonString.replace(/`/g, '\\`'); 
            return `window.motorMonkeyProjectData = JSON.parse(\`${jsonString}\`);`;
        }
    }


    aplicarDadosDoProjeto(loadedProjectData, aceEditorInstance, fileSystemInstance, setActiveWorldPathCallback) {
        const decodeString = (encodedStr) => encodedStr ? decodeURIComponent(atob(encodedStr)) : null;

        const decodeFileSystem = (node, decodeKeys) => {
            const decodedNode = {};
            for (const key in node) {
                if (node.hasOwnProperty(key)) {
                    const value = node[key];
                    const newKey = decodeKeys ? this._firebaseDecodeKey(key) : key;

                    if (typeof value === 'object' && value !== null && !value.type) { 
                        decodedNode[newKey] = decodeFileSystem(value, decodeKeys);
                    } else if (typeof value === 'object' && value !== null && value.type) { 
                        decodedNode[newKey] = { ...value }; 
                        if (decodedNode[newKey].url && typeof decodedNode[newKey].url === 'string') {
                            decodedNode[newKey].url = decodeString(decodedNode[newKey].url);
                        }
                        if (decodedNode[newKey].content && typeof decodedNode[newKey].content === 'string') {
                            decodedNode[newKey].content = decodeString(decodedNode[newKey].content);
                        }
                    } else { 
                        decodedNode[newKey] = value;
                    }
                }
            }
            return decodedNode;
        };

        // 1. Limpar e restaurar fileSystem
        for (const key in fileSystemInstance) { 
            if (fileSystemInstance.hasOwnProperty(key)) {
                delete fileSystemInstance[key];
            }
        }
        Object.assign(fileSystemInstance, decodeFileSystem(loadedProjectData.fileSystem || { 'assets': { 'textures': {}, 'scripts': {}, 'mundos': {} } }, true)); 
        
        // 2. Definir o mundo ativo e carregar seu script no Ace Editor
        let finalActiveWorldPath = ['assets', 'mundos', 'mundo_padrao.js']; // Padrão
        if (loadedProjectData.activeWorldPath && loadedProjectData.activeWorldPath.length > 0) {
            finalActiveWorldPath = loadedProjectData.activeWorldPath.map(p => this._firebaseDecodeKey(p));
        }
        
        // Garante que as pastas do activeWorldPath existam no fileSystemInstance
        let currentFsLevel = fileSystemInstance;
        for(let i = 0; i < finalActiveWorldPath.length -1; i++) {
            const pathPart = finalActiveWorldPath[i]; // Usa nome decodificado para navegar
            if (!currentFsLevel[pathPart]) {
                currentFsLevel[pathPart] = {}; // Cria a pasta se não existir
            }
            currentFsLevel = currentFsLevel[pathPart];
        }

        const activeWorldFileName = finalActiveWorldPath[finalActiveWorldPath.length - 1];
        const activeWorldFileEntry = currentFsLevel ? currentFsLevel[activeWorldFileName] : null; // Usa nome decodificado para buscar
        
        if (activeWorldFileEntry && activeWorldFileEntry.type === 'script' && typeof activeWorldFileEntry.content === 'string') {
            aceEditorInstance.setValue(activeWorldFileEntry.content, -1);
        } else {
            console.warn("Nenhum script de mundo ativo encontrado para carregar no editor. Carregando script padrão.");
            const defaultScriptContent = `// Mundo Padrão - Motor Monkey\n\nconsole.log("Mundo Padrão Carregado!");\n`;
            aceEditorInstance.setValue(defaultScriptContent, -1);
            const defaultWorldDecodedKey = 'mundo_padrao.js';
            if (!fileSystemInstance.assets.mundos[defaultWorldDecodedKey]) {
                 fileSystemInstance.assets.mundos[defaultWorldDecodedKey] = { type: 'script', content: defaultScriptContent, url: '' };
            }
            finalActiveWorldPath = ['assets','mundos', defaultWorldDecodedKey];
        }
        setActiveWorldPathCallback(finalActiveWorldPath); 


        // 3. Aplicar configurações de cena
        const sceneSettings = loadedProjectData.sceneSettings;
        if (sceneSettings) {
            if (sceneSettings.gravity) { 
                this.configurarGravidade(...sceneSettings.gravity);
            }
            if (sceneSettings.fogConfig) { 
                this.configurarNeblina(sceneSettings.fogConfig);
            }
            if (sceneSettings.backgroundConfig) { 
                const envMapNameDecoded = sceneSettings.backgroundConfig.environmentMapName;
                // Procura a textura no fileSystem usando a chave decodificada
                const envMapFile = (envMapNameDecoded && envMapNameDecoded !== 'Nenhuma') ? 
                                   fileSystemInstance.assets?.textures?.[envMapNameDecoded] : 
                                   null; 
                
                this.configurarFundoCena({ 
                    color: sceneSettings.backgroundConfig.color, 
                    environmentMap: envMapFile ? envMapFile.url : null 
                });
            }
            if (sceneSettings.renderSettings) {
                this.aplicarConfiguracoesDeRenderizacao(sceneSettings.renderSettings);
            }
        }
    }
}
