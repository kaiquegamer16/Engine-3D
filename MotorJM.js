

class MotorJM {
    /**
     * Construtor da classe MotorJM.
     * @param {string} containerId - O ID do elemento HTML onde o canvas do renderizador será anexado.
     * @param {object} [opcoes] - Opções de configuração inicial para o motor.
     */
    constructor(containerId, opcoes = {}) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`MotorJM (Erro Fatal): O elemento com o ID '${containerId}' não foi encontrado. O motor não pode ser inicializado sem um container válido.`);
            return; // Impede que o motor continue a inicialização se o container não existe
        }

        // --- Componentes Principais ---
        this.cena = new THREE.Scene();
        this.renderizador = new THREE.WebGLRenderer({ antialias: true }); // Antialiasing inicial
        this.textureLoader = new THREE.TextureLoader(); // Carregador de texturas
        this.rgbeLoader = new THREE.RGBELoader(); // NOVO: Carregador para arquivos HDR

        // --- Câmeras ---
        this.editorCamera = null; // A câmera usada no modo de edição (OrbitControls)
        this.activeCamera = null; // A câmera atualmente sendo usada para renderizar (editor ou jogo)
        this.tempEditorCameraTarget = new THREE.Vector3(); // Para guardar o target do OrbitControls ao entrar no play

        // --- Controles e Interação ---
        this.controlesOrbit = null;
        this.controlesTransform = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.objetoSelecionadoId = null;
        
        // --- Propriedades de Cena ---
        // NOVO: rastreia as configurações de fundo para o script gerado
        this.cena._backgroundConfig = { color: '#1a1a1a', environmentMapName: 'Nenhuma' }; 

        // --- Física ---
        this.mundoFisica = new CANNON.World();
        this.mundoFisica.solver.iterations = opcoes.solverIterations || 10; // Maior estabilidade na simulação
        this.mundoFisica.defaultContactMaterial.contactEquationStiffness = 1e9; // Reduz penetração entre corpos
        this.mundoFisica.defaultContactMaterial.contactEquationRelaxation = 4; // Contatos mais suaves

        // --- Estado Interno ---
        // Armazena todos os objetos gerenciados pelo motor, incluindo Three.js, Cannon.js e a malha de colisão
        this.objetosNaCena = {}; 
        this.estaRodando = false; // Controla o estado da simulação (play/pause)
        
        // --- Inicialização ---
        this._configurarRenderizador();
        this._configurarCamera(opcoes);
        this._configurarIluminacaoPadrao();
        this._configurarMundoFisica(opcoes);
        this._configurarControles();
        this._configurarEventos();

        console.log("MotorJM (Info): Motor inicializado com sucesso.");
    }

    // --- MÉTODOS DE CONFIGURAÇÃO INTERNA ---

    /** Configura o renderizador WebGL com sombras e mapeamento de tons para PBR. */
    _configurarRenderizador() {
        this.renderizador.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderizador.shadowMap.enabled = true;
        this.renderizador.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderizador.outputEncoding = THREE.sRGBEncoding;
        this.renderizador.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderizador.toneMappingExposure = 1.0;
        this.renderizador.setPixelRatio(window.devicePixelRatio || 1); // Garante boa resolução em telas de alta densidade
        this.container.appendChild(this.renderizador.domElement);
    }

    /** Configura a câmera e o fundo da cena. */
    _configurarCamera(opcoes = {}) {
        // A câmera padrão do editor
        this.editorCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000); // Aspect ratio será definido dinamicamente
        this.editorCamera.position.set(0, 10, opcoes.distanciaCameraInicial || 20);
        this.editorCamera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.editorCamera.updateProjectionMatrix();
        
        this.activeCamera = this.editorCamera; // Inicialmente, a câmera ativa é a do editor
        this.cena.background = new THREE.Color(this.cena._backgroundConfig.color); // Fundo escuro padrão
    }

    /** Adiciona luzes padrão para que a cena não comece totalmente escura. */
    _configurarIluminacaoPadrao() {
        // As luzes padrão são adicionadas com um ID que termina em '_padrao' para serem ignoradas na geração do script
        this.adicionarLuz('luz_ambiente_padrao', 'Luz Ambiente Padrão', { type: 'ambiente', color: 0xffffff, intensity: 0.3 });
        this.adicionarLuz('luz_direcional_padrao', 'Luz Direcional Padrão', { type: 'direcional', color: 0xffffff, intensity: 1, position: new THREE.Vector3(10, 20, 10), castShadow: true });
    }

    /** Configura as propriedades globais do mundo da física. */
    _configurarMundoFisica(opcoes = {}) {
        this.mundoFisica.gravity.copy(opcoes.gravidade || new CANNON.Vec3(0, -9.82, 0));
        this.mundoFisica.broadphase = new CANNON.SAPBroadphase(this.mundoFisica);
        this.mundoFisica.defaultContactMaterial.friction = opcoes.friccaoPadrao || 0.7;
        this.mundoFisica.defaultContactMaterial.restitution = opcoes.restituicaoPadrao || 0.3;
    }

    /** Inicializa os controles de órbita e transformação. */
    _configurarControles() {
        this.controlesOrbit = new THREE.OrbitControls(this.editorCamera, this.renderizador.domElement); // OrbitControls usa a editorCamera
        this.controlesOrbit.enableDamping = true;

        this.controlesTransform = new THREE.TransformControls(this.editorCamera, this.renderizador.domElement); // TransformControls usa a editorCamera
        this.cena.add(this.controlesTransform);

        // Desativa os controles de órbita enquanto os controles de transformação estiverem ativos
        this.controlesTransform.addEventListener('dragging-changed', (event) => {
            this.controlesOrbit.enabled = !event.value;
        });

        // Sincroniza a física quando um objeto é movido no modo de edição
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

    /** Configura os listeners de eventos globais. */
    _configurarEventos() {
        window.addEventListener('resize', () => this._aoRedimensionarJanela());
        this.renderizador.domElement.addEventListener('click', (e) => {
            if (this.controlesTransform.dragging) return; // Evita seleção se estiver arrastando
            this._manipularSelecao(e);
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && !this.estaRodando) this.removerObjetoSelecionado();
        });
    }
    
    /** Mapeia nomes de cores em português para códigos hexadecimais. */
    _traduzirCor(nomeCor) {
        const mapaCores = {
            'vermelho': '#ff0000', 'verde': '#00ff00', 'azul': '#0000ff',
            'amarelo': '#ffff00', 'ciano': '#00ffff', 'magenta': '#ff00ff',
            'branco': '#ffffff', 'preto': '#000000', 'cinza': '#808080',
            'laranja': '#ffa500', 'roxo': '#800080', 'marrom': '#a52a2a',
            'prata': '#c0c0c0', 'ouro': '#ffd700', 'bronze': '#cd7f32'
        };
        // Retorna o código hex se encontrado, senão retorna o valor original (pode ser hex ou nome inglês)
        return mapaCores[String(nomeCor).toLowerCase()] || nomeCor; 
    }
    
    /**
     * Cria um material PBR (Physically Based Rendering) padrão.
     * Suporta cor base, rugosidade, metalização e mapas de textura.
     * @param {object} opcoes - Opções para o material.
     * @returns {THREE.MeshStandardMaterial} O material Three.js criado.
     */
    _criarMaterial(opcoes = {}) {
        if (typeof opcoes !== 'object' || opcoes === null) {
            console.warn(`MotorJM (Aviso Material): Opções de material inválidas ou ausentes. Usando valores padrão.`);
            opcoes = {}; 
        }

        let corFinal = this._traduzirCor(opcoes.color || '#ffffff');
        
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(corFinal),
            roughness: opcoes.roughness !== undefined ? opcoes.roughness : 0.5,
            metalness: opcoes.metalness !== undefined ? opcoes.metalness : 0.5,
        });

        const carregarTextura = (mapType, url) => {
            if (!url) {
                console.warn(`MotorJM (Aviso Textura): URL de textura para '${mapType}' está vazia ou inválida. Ignorando.`);
                return null;
            }
            const textura = this.textureLoader.load(url, (tex) => {
                if (mapType === 'map') tex.encoding = THREE.sRGBEncoding; 
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping; 
                material.needsUpdate = true; 
            }, 
            undefined, 
            (err) => {
                console.error(`MotorJM (Erro Textura): Não foi possível carregar a textura de '${url}' para o mapa '${mapType}'.`, err);
            });
            try { textura.name = url.substring(url.lastIndexOf('/') + 1); } catch (e) { textura.name = url; }
            return textura;
        };
        
        // Aceita url direta (string) ou um objeto {url: string, name: string}
        if (opcoes.map) material.map = carregarTextura('map', typeof opcoes.map === 'string' ? opcoes.map : opcoes.map.url);
        if (opcoes.metalnessMap) material.metalnessMap = carregarTextura('metalnessMap', typeof opcoes.metalnessMap === 'string' ? opcoes.metalnessMap : opcoes.metalnessMap.url);
        if (opcoes.roughnessMap) material.roughnessMap = carregarTextura('roughnessMap', typeof opcoes.roughnessMap === 'string' ? opcoes.roughnessMap : opcoes.roughnessMap.url);
        
        return material;
    }


    // --- MÉTODOS PÚBLICOS DE CONTROLE DA SIMULAÇÃO ---

    /** Inicia o loop de animação (renderização contínua). */
    iniciar() {
        this._loopAnimacao();
    }

    /** Inicia a simulação da física, desativando os controles de edição. */
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
            if (obj.collisionWireframe) {
                obj.collisionWireframe.visible = false;
            }
            if (obj.cameraHelper) { 
                obj.cameraHelper.visible = false;
            }
        });

        console.log(`MotorJM (Info): Simulação iniciada. Câmera ativa: ${this.activeCamera === this.editorCamera ? 'Editora' : (this.objetosNaCena[this.objetoSelecionadoId]?.name || 'Câmera de Jogo Selecionada')}.`);
    }

    /** Para a simulação da física e reseta todos os objetos para suas posições e rotações iniciais. */
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

        if (this.objetoSelecionadoId) {
            this.selecionarObjeto(this.objetoSelecionadoId); 
        }
    }
    
    /** O coração do motor: atualiza controles, física e renderiza a cena a cada quadro. */
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

    /**
     * Adiciona um novo objeto geométrico à cena e, opcionalmente, ao mundo da física.
     * @param {string} id - Um identificador único para o objeto.
     * @param {string} name - Um nome amigável para exibição na UI.
     * @param {string} type - O tipo de geometria ('caixa', 'esfera', 'plano', 'camera', etc.).
     * @param {object} [opcoes] - Opções de configuração para posição, material, física, etc.
     *   - opcoes.physics.bodyType: 'none' | 'static' | 'dynamic' (padrão: 'none' para objetos, 'static' para plano)
     *   - opcoes.physics.mass: number (padrão: 1, relevante apenas para 'dynamic')
     *   - opcoes.physics.friction: number (padrão: 0.7)
     *   - opcoes.physics.restitution: number (padrão: 0.3)
     *   - opcoes.physics.collisionShape: 'box' | 'sphere' | 'plane' (padrão inferido pelo tipo)
     *   - opcoes.physics.linearDamping: number (padrão: 0.01)
     *   - opcoes.physics.angularDamping: number (padrão: 0.01)
     *   - opcoes.fov: number (para câmeras)
     *   - opcoes.near: number (para câmeras)
     *   - opcoes.far: number (para câmeras)
     * @returns {object|null} O objeto recém-criado (com threeObj e cannonBody) ou nulo se o ID já existir.
     */
    adicionarObjeto(id, name, type, opcoes = {}) {
        if (this.objetosNaCena[id]) {
            console.warn(`MotorJM (Aviso Objeto): Tentativa de adicionar objeto com ID repetido '${id}'. Use um ID único. Operação cancelada.`);
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

        } else { // Lógica para objetos geométricos (meshes)
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
                    console.error(`MotorJM (Erro Objeto): Tipo de objeto geométrico desconhecido: '${type}'. Tipos suportados: 'caixa', 'esfera', 'plano', 'camera'.`);
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

    /**
     * Cria, atualiza ou remove o corpo Cannon.js de um objeto.
     * @param {object} obj - O objeto do motor (de this.objetosNaCena)
     */
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
                console.warn(`MotorJM (Aviso Física): Massa negativa (${finalMass}) detectada para o objeto dinâmico '${obj.id}'. Usando massa 1.`);
                finalMass = 1;
                obj.physicsProperties.mass = 1; 
            }
        } else if (obj.physicsProperties.bodyType === 'static') {
            finalMass = 0; 
            obj.physicsProperties.mass = 0; 
        } else { // bodyType === 'none'
            obj.collisionWireframe.material.color.set(this._traduzirCor('vermelho')); 
            obj.collisionWireframe.material.needsUpdate = true;
            console.log(`MotorJM (Info Física): Corpo físico para '${obj.id}' removido (bodyType: 'none').`);
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
                    console.error(`MotorJM (Erro Física): Forma de colisão desconhecida: '${obj.physicsProperties.collisionShape}' para o objeto '${obj.id}'. Não foi possível criar o corpo físico.`);
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
            console.log(`MotorJM (Info Física): Corpo físico para '${obj.id}' criado/recriado (Tipo: '${obj.physicsProperties.bodyType}', Massa: ${finalMass}, Fricção: ${obj.physicsProperties.friction}, Restituição: ${obj.physicsProperties.restitution}, Forma: ${obj.physicsProperties.collisionShape}, LinearDamping: ${obj.physicsProperties.linearDamping}, AngularDamping: ${obj.physicsProperties.angularDamping}).`);
            this._atualizarCorMalhaColisao(obj.id); 
        } catch (e) {
            console.error(`MotorJM (Erro Física): Falha ao criar/recriar corpo físico para '${obj.id}':`, e);
            obj.cannonBody = null; 
            this._atualizarCorMalhaColisao(obj.id); 
        }
    }

    /**
     * Atualiza a cor da malha de colisão de um objeto com base no seu tipo de corpo físico.
     * @param {string} id - O ID do objeto.
     */
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
             console.warn(`MotorJM (Aviso Luz): Tentativa de adicionar luz com ID repetido '${id}'. Use um ID único. Operação cancelada.`);
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
                console.error(`MotorJM (Erro Luz): Tipo de luz desconhecido: '${opcoes.type}'. Tipos suportados: 'ambiente', 'direcional', 'ponto'.`); 
                return;
        }
        this.cena.add(luz); 
        this.objetosNaCena[id] = { id, name, type: `luz_${opcoes.type}`, threeObj: luz };
        console.log(`MotorJM (Info Luz): Luz '${name}' (ID: ${id}, Tipo: ${opcoes.type}) adicionada.`);
    }

    /** Remove um objeto da cena e do mundo da física, liberando memória. */
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
                obj.cameraHelper.material.dispose();
                obj.cameraHelper.geometry.dispose();
            }
        }
        
        if (obj.cannonBody) {
            this.mundoFisica.removeBody(obj.cannonBody);
        }
        
        delete this.objetosNaCena[id]; 
        console.log(`MotorJM (Info Remoção): Objeto '${obj.name || obj.id}' removido com sucesso.`);
    }
    
    /** Atalho para remover o objeto atualmente selecionado. */
    removerObjetoSelecionado() { 
        if (this.objetoSelecionadoId) {
            this.removerObjeto(this.objetoSelecionadoId);
        } else {
            console.warn("MotorJM (Aviso Remoção): Nenhum objeto selecionado para remover.");
        }
    }
    
    /** Remove todos os objetos da cena (exceto as luzes padrão). */
    limparCena() { 
        const idsParaRemover = Object.keys(this.objetosNaCena).filter(id => !id.endsWith('_padrao'));
        if (idsParaRemover.length === 0) {
            console.log("MotorJM (Info Limpeza): Nenhuns objetos adicionados pelo usuário para remover.");
        }
        idsParaRemover.forEach(id => this.removerObjeto(id));
        console.log(`MotorJM (Info Limpeza): Cena limpa. ${idsParaRemover.length} objetos removidos.`);

        // NOVO: Resetar background e environment map para o estado padrão
        this.cena.background = new THREE.Color(this.cena._backgroundConfig.color);
        if (this.cena.environment) {
            this.cena.environment.dispose();
            this.cena.environment = null;
        }
        this.cena._backgroundConfig.environmentMapName = 'Nenhuma';
    }


    // --- MÉTODOS DE MANIPULAÇÃO E INTERAÇÃO ---

    /**
     * Seleciona um objeto na cena para edição e anexar os controles de transformação.
     * @param {string} id - O ID do objeto a ser selecionado.
     */
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

    /** Desseleciona o objeto atualmente selecionado, desanexando os controles de transformação. */
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
    
    /**
     * Atualiza uma propriedade de um objeto dinamicamente. Suporta propriedades aninhadas e tipos específicos (cor, textura, física, câmera).
     * @param {string} id - O ID do objeto a ser atualizado.
     * @param {string} prop - A propriedade a ser alterada (ex: 'position.x', 'material.color', 'physics.mass', 'fov').
     * @param {*} value - O novo valor para a propriedade.
     */
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
                console.error(`MotorJM (Erro Atualização): Propriedade aninhada '${keys[i]}' não encontrada no caminho '${prop}' para o objeto '${id}'. Não foi possível atualizar.`);
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
            // Aceita o Data URL diretamente para carregamento
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
                console.error(`MotorJM (Erro Atualização): Valor de textura inválido para '${finalKey}' no objeto '${id}'. Esperava {url: string, name: string} ou null.`);
            }
        } else {
            if (target[finalKey] === undefined) {
                console.error(`MotorJM (Erro Atualização): Propriedade '${finalKey}' não existe para o objeto '${id}' no caminho '${prop}'. Não foi possível atualizar.`);
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
    
    /** Retorna o mapa de todos os objetos atualmente na cena. */
    getObjetosNaCena() { return this.objetosNaCena; }
    /** Retorna os controles de transformação para manipulação direta (para a UI). */
    getControlesTransform() { return this.controlesTransform; }
    
    /**
     * Configura a neblina na cena.
     * @param {object} opcoes - {enabled: boolean, color: string, near: number, far: number}
     */
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
    
    /**
     * Configura a gravidade do mundo da física.
     * @param {number} x - Gravidade no eixo X.
     * @param {number} y - Gravidade no eixo Y.
     * @param {number} z - Gravidade no eixo Z.
     */
    configurarGravidade(x, y, z) { 
        this.mundoFisica.gravity.set(x, y, z);
        console.log(`MotorJM (Info Cena): Gravidade configurada para X:${x}, Y:${y}, Z:${z}.`);
    }

    /**
     * Configura o fundo da cena (cor sólida ou imagem ambiente).
     * @param {object} opcoes - {color: string (opcional), environmentMap: File | string | null (opcional)}
     */
    configurarFundoCena(opcoes = {}) {
        // Se a cor for fornecida, atualiza o background e a configuração salva
        if (opcoes.color !== undefined) {
            this.cena.background = new THREE.Color(this._traduzirCor(opcoes.color));
            this.cena._backgroundConfig.color = opcoes.color;
            console.log(`MotorJM (Info Cena): Cor de fundo alterada para '${opcoes.color}'.`);
        }

        // Limpa ambiente map existente para evitar acúmulo antes de carregar um novo
        if (this.cena.environment) {
            this.cena.environment.dispose();
            this.cena.environment = null;
        }

        if (opcoes.environmentMap !== undefined && opcoes.environmentMap !== null) {
            const source = opcoes.environmentMap; // Pode ser File (upload) ou Data URL (projeto carregado)
            let fileUrl = typeof source === 'string' ? source : URL.createObjectURL(source);
            let fileName = typeof source === 'string' ? `(Embedded) ${source.substring(source.lastIndexOf('/') + 1, source.lastIndexOf(';'))}` : source.name;

            // Atualiza o nome da imagem ambiente na configuração da cena
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
                    if (typeof source !== 'string') URL.revokeObjectURL(fileUrl); // Apenas revoga se foi criado localmente
                    console.log(`MotorJM (Info Cena): Imagem ambiente HDR '${fileName}' carregada.`);
                }, undefined, (err) => {
                    console.error(`MotorJM (Erro Cena): Falha ao carregar imagem ambiente HDR '${fileName}':`, err);
                    if (typeof source !== 'string') URL.revokeObjectURL(fileUrl);
                });
            } else if (fileName.match(/\.(png|jpg|jpeg)$/i) || fileUrl.startsWith('data:image/')) { // Imagens comuns
                this.textureLoader.load(fileUrl, (texture) => {
                    const pmremGenerator = new THREE.PMREMGenerator(this.renderizador);
                    pmremGenerator.compileEquirectangularShader();
                    const envMap = pmremGenerator.fromEquirectangular(texture).texture;

                    this.cena.environment = envMap;
                    this.cena.background = new THREE.CubeTextureLoader().load([
                        fileUrl, fileUrl, fileUrl, fileUrl, fileUrl, fileUrl // Simula um cube map para background
                    ]); 
                    texture.dispose();
                    pmremGenerator.dispose();
                    if (typeof source !== 'string') URL.revokeObjectURL(fileUrl);
                    console.log(`MotorJM (Info Cena): Imagem ambiente '${fileName}' carregada.`);
                }, undefined, (err) => {
                    console.error(`MotorJM (Erro Cena): Falha ao carregar imagem ambiente '${fileName}':`, err);
                    if (typeof source !== 'string') URL.revokeObjectURL(fileUrl);
                });
            } else {
                console.warn(`MotorJM (Aviso Cena): Tipo de arquivo para imagem ambiente não suportado: '${fileName}'.`);
                if (typeof source !== 'string') URL.revokeObjectURL(fileUrl);
            }
        } else if (opcoes.environmentMap === null) { // Caso o environmentMap seja explicitamente null
            this.cena.environment = null;
            this.cena.background = new THREE.Color(this._traduzirCor(opcoes.color || '#1a1a1a')); // Volta para cor de fundo
            this.cena._backgroundConfig.environmentMapName = 'Nenhuma';
            console.log("MotorJM (Info Cena): Imagem ambiente removida.");
        }
    }

    /**
     * Aplica configurações de renderização diretamente ao renderizador.
     * @param {object} opcoes - Objeto com as configurações de renderização.
     *   - sombrasHabilitadas: boolean
     *   - tipoSombra: 'BasicShadowMap' | 'PCFSoftShadowMap' | 'VSMShadowMap'
     *   - toneMappingHabilitado: boolean
     *   - exposicaoToneMapping: number
     *   - pixelRatio: number
     *   - shadowMapSize: number (para luzes direcionais)
     */
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

    /**
     * Aplica um preset de qualidade gráfica.
     * @param {'baixa'|'media'|'alta'} preset - O nível de qualidade a ser aplicado.
     * @returns {object} As configurações aplicadas pelo preset.
     */
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

    /** Redimensiona o renderizador e a câmera quando a janela muda de tamanho. */
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
    
    /** Manipula cliques no canvas para seleção de objetos. */
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

    /**
     * Executa um script JavaScript fornecido como string.
     * @param {string} code - O código JavaScript a ser executado.
     * @param {string} [name='(script)'] - Um nome para o script, usado em mensagens de erro.
     */
    executeScript(code, name = '(script)') {
        try {
            new Function('motor', code)(this); 
            console.log(`MotorJM (Info Script): Script '${name}' executado com sucesso.`);
        } catch (e) {
            console.error(`MotorJM (Erro Script): Erro ao executar script '${name}':`, e);
            throw e; 
        }
    }
    
    // --- GERAÇÃO DE SCRIPT ---

    /** Gera uma string de código Javascript que recria o estado atual da cena no editor. */
    gerarScriptDaCena() {
        let script = `// Script gerado pelo Motor Monkey Editor\n// Para funcionar, as texturas devem estar na mesma pasta do index.html ou ter URLs completas.\n\n`;
        script += `motor.limparCena();\n\n`; 
        
        const g = this.mundoFisica.gravity;
        script += `motor.configurarGravidade(${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)});\n`;
        
        if (this.cena.fog) {
            const fogColorHex = `#${this.cena.fog.color.getHexString()}`;
            script += `motor.configurarNeblina({ enabled: true, color: '${fogColorHex}', near: ${this.cena.fog.near.toFixed(2)}, far: ${this.cena.fog.far.toFixed(2)} });\n`;
        } else {
            script += `motor.configurarNeblina({ enabled: false });\n`;
        }

        // Configurações de Fundo da Cena (Cor e Ambiente Map)
        let backgroundOpts = {};
        if (this.cena.background?.isColor) {
            backgroundOpts.color = `#${this.cena.background.getHexString()}`;
        }
        if (this.cena._backgroundConfig.environmentMapName && this.cena._backgroundConfig.environmentMapName !== 'Nenhuma') {
            // Nota: Salva apenas o NOME do arquivo. O usuário precisará ter esse arquivo no projeto carregado.
            backgroundOpts.environmentMap = this.cena._backgroundConfig.environmentMapName; 
        } else {
            backgroundOpts.environmentMap = null; 
        }
        script += `motor.configurarFundoCena(${JSON.stringify(backgroundOpts, null, 2)});\n`;


        const renderer = this.renderizador;
        const currentShadowMapSize = Object.values(this.objetosNaCena)
                                       .filter(obj => obj.threeObj.isDirectionalLight && obj.threeObj.shadow)
                                       .map(obj => obj.threeObj.shadow.mapSize.width)[0] || 1024; 
        const renderSettings = {
            sombrasHabilitadas: renderer.shadowMap.enabled,
            tipoSombra: Object.keys(THREE).find(key => THREE[key] === renderer.shadowMap.type) || 'PCFSoftShadowMap',
            toneMappingHabilitado: renderer.toneMapping !== THREE.NoToneMapping,
            exposicaoToneMapping: parseFloat(renderer.toneMappingExposure.toFixed(2)),
            pixelRatio: parseFloat(renderer.getPixelRatio().toFixed(2)),
            shadowMapSize: currentShadowMapSize 
        };
        script += `motor.aplicarConfiguracoesDeRenderizacao(${JSON.stringify(renderSettings, null, 2)});\n\n`;
        
        Object.values(this.objetosNaCena).forEach(obj => {
            if (obj.id.endsWith('_padrao')) return;

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
                    // Salva o nome da textura se ela existir (não a Data URL, pois Data URLs são muito grandes para gerar script)
                    // Para o script gerado, assumimos que as texturas estão disponíveis por nome de arquivo (caminho relativo ou URL)
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

    /**
     * Gera uma string de código JavaScript que define uma variável global `window.motorMonkeyProjectData`
     * contendo o script da cena, a estrutura do gerenciador de arquivos e configurações da cena.
     * Isso permite salvar e carregar o projeto completo em um único arquivo .js.
     * @param {string} sceneScriptContent - O conteúdo atual do script da cena (do Ace Editor).
     * @param {object} fileSystemData - O objeto global `fileSystem` do gerenciador de arquivos.
     * @param {object} backgroundConfig - As configurações de fundo da cena.
     * @param {Array<number>} gravity - O vetor de gravidade atual [x, y, z].
     * @param {boolean} shadowsEnabled - Se as sombras estão habilitadas.
     * @param {string} shadowMapType - O tipo de shadow map.
     * @param {boolean} toneMappingEnabled - Se o tone mapping está habilitado.
     * @param {number} toneMappingExposure - A exposição do tone mapping.
     * @param {number} pixelRatio - O pixel ratio do renderizador.
     * @param {number} shadowMapSize - O tamanho do mapa de sombras.
     * @returns {string} Uma string JavaScript serializável representando o projeto completo.
     */
    gerarDadosDoProjeto(sceneScriptContent, fileSystemData, backgroundConfig, gravity, 
                        shadowsEnabled, shadowMapType, toneMappingEnabled, toneMappingExposure, pixelRatio, shadowMapSize) {
        
        // CUIDADO: JSON.stringify é seguro, mas colocar o resultado dentro de template literals (``)
        // requer que o JSON não contenha o caractere de backtick (`) ou ${}.
        // Para sceneScript, que pode ter qualquer coisa, a melhor prática é encapsulá-lo e decodificá-lo.
        // Uma maneira simples é usar btoa(encodeURIComponent(...)) para o conteúdo do script
        // que será decodificado com decodeURIComponent(atob(...)) ao carregar.
        // Alternativamente, JSON.stringify já faz o escape necessário para strings.
        // Vou usar JSON.stringify para o objeto completo e injetá-lo numa template string.

        const projectData = {
            motorMonkeyProject: true,
            version: "1.1", // Incrementando a versão do projeto
            sceneScript: sceneScriptContent, // AceEditor content
            fileSystem: fileSystemData, // Completo com Data URLs
            backgroundConfig: backgroundConfig,
            gravity: gravity,
            // Adicionando configurações de renderização
            renderSettings: {
                sombrasHabilitadas: shadowsEnabled,
                tipoSombra: shadowMapType,
                toneMappingHabilitado: toneMappingEnabled,
                exposicaoToneMapping: toneMappingExposure,
                pixelRatio: pixelRatio,
                shadowMapSize: shadowMapSize
            },
            // Adicionar aqui outras configurações globais da cena (neblina)
            fogConfig: this.cena.fog ? {
                enabled: true,
                color: `#${this.cena.fog.color.getHexString()}`,
                near: this.cena.fog.near,
                far: this.cena.fog.far
            } : { enabled: false }
        };

        // Stringify o objeto de dados. JSON.stringify por padrão escapa aspas e outros caracteres especiais.
        // O desafio é que o resultado do JSON.stringify será inserido dentro de um template literal (`),
        // então precisamos ter certeza de que NENHUM backtick (`) apareça no JSON, ou que seja escapado.
        // Para simplificar e garantir a segurança, vamos serializar o JSON e depois aplicar um escape
        // MINIMALISTA apenas para backticks antes de injetá-lo na template string.
        let jsonString = JSON.stringify(projectData, null, 2);
        // Escapa backticks que podem estar no script da cena ou URLs de dados
        jsonString = jsonString.replace(/`/g, '\\`');

        return `// Motor Monkey Project File (Version ${projectData.version})
// Este arquivo contém a cena e os recursos do seu projeto Motor Monkey.
// Não edite manualmente este arquivo, a menos que você saiba o que está fazendo.

// Define uma variável global para armazenar os dados do projeto.
// Isso permite que o código JavaScript do Motor Monkey os carregue após a execução deste script.
window.motorMonkeyProjectData = JSON.parse(\`
${jsonString}
\`);
`;
    }
}