import {
    Entity, 
    ConstantPositionProperty,
    ConstantProperty,
    ReferenceFrame,
    Cartesian3,
    Matrix3,
    Matrix4,
    CesiumMath,
    Quaternion,
    Transforms,
    JulianDate,
    PerspectiveFrustum,
    defined
} from './cesium/cesium-imports'

import {autoinject} from 'aurelia-dependency-injection';
import {ContextService, ContextServiceProvider} from './context'
import {SessionService, SessionPort} from './session'

import {
    AVERAGE_EYE_HEIGHT,
    DEFAULT_NEAR_PLANE,
    DEFAULT_FAR_PLANE,
    CanvasViewport,
    Viewport,
    SerializedSubviewList,
    SerializedEntityStateMap,
    SubviewType,
    ContextFrameState,
    GeolocationOptions
} from './common'

import {
    Event,
    getEntityPositionInReferenceFrame,
    getEntityOrientationInReferenceFrame,
    getSerializedEntityState,
    requestAnimationFrame,
    cancelAnimationFrame,
    // getAncestorReferenceFrames,
    // getReachableAncestorReferenceFrames
} from './utils'

import {
    ViewService,
    ViewportMode
} from './view'

import { VisibilityService } from './visibility'

export class DeviceState {
    viewport?:CanvasViewport;
    subviews?:SerializedSubviewList;
    entities:SerializedEntityStateMap = {};
    suggestedUserHeight = AVERAGE_EYE_HEIGHT;
    geolocationDesired = false;
    geolocationOptions:GeolocationOptions = {};
    isPresentingHMD = false;
    strict = false;
}

export class DeviceFrameState extends DeviceState {
    private _scratchFrustum = new PerspectiveFrustum();

    screenOrientationDegrees = 0;

    time = JulianDate.now();

    viewport = new CanvasViewport;

    subviews:SerializedSubviewList = [{
        type: SubviewType.SINGULAR,
        pose: null,
        viewport: new Viewport,
        projectionMatrix: (
            this._scratchFrustum.near = DEFAULT_NEAR_PLANE,
            this._scratchFrustum.far = DEFAULT_FAR_PLANE,
            this._scratchFrustum.fov = CesiumMath.PI_OVER_THREE, 
            this._scratchFrustum.aspectRatio = 1, 
            Matrix4.clone(this._scratchFrustum.projectionMatrix)
        )
    }];
};

let vrDisplays:VRDisplay[]|undefined;
let vrDisplay:VRDisplay|undefined;

if (typeof navigator !== 'undefined' && navigator.getVRDisplays) {
    navigator.getVRDisplays().then(displays => {
        vrDisplays = displays;
        vrDisplay = displays[0];
    });
}

@autoinject()
export class DeviceService {

    public autoSubmitFrame = true;

    public deviceState = new DeviceState; 

    public frameState = new DeviceFrameState;

    public frameStateEvent = new Event<DeviceFrameState>();

    /**
     * An entity representing the physical floor-level plane below the user,
     * where +X is east, +Y is North, and +Z is up (if geolocation is known)
     */
    public stage: Entity = this.contextService.entities.add(new Entity({
        id: 'ar.device.stage',
        name: 'Device Stage',
        position: undefined,
        orientation: undefined
    }));

    /**
     * An entity representing the physical pose of the user, 
     * where +X is right, +Y is up, and -Z is forward
     */
    public user: Entity = this.contextService.entities.add(new Entity({
        id: 'ar.device.user',
        name: 'Device User',
        position: undefined,
        orientation: undefined
    }));
    
    public get geoHeadingAccuracy() : number|undefined {
        return this.user['meta'] ? this.user['meta'].geoHeadingAccuracy : undefined;
    }

    public get geoHorizontalAccuracy() : number|undefined {
        return this.stage['meta'] ? this.stage['meta'].geoHorizonatalAccuracy : undefined;
    }
    
    public get geoVerticalAccuracy() : number|undefined {
        return this.stage['meta'] ? this.stage['meta'].geoVerticalAccuracy : undefined;
    }

    private _getEntityPositionInReferenceFrame = getEntityPositionInReferenceFrame;
    private _getEntityOrientationInReferenceFrame = getEntityOrientationInReferenceFrame;
    protected _scratchCartesian = new Cartesian3;
    protected _scratchCartesian2 = new Cartesian3;
    protected _scratchFrustum = new PerspectiveFrustum();

    constructor(
        protected sessionService:SessionService,
        protected contextService:ContextService,
        protected viewService:ViewService,
        protected visibilityService:VisibilityService
    ) {
        sessionService.manager.on['ar.device.state'] = 
            sessionService.manager.on['ar.device.frameState'] = this._onDeviceState.bind(this);

        this.visibilityService.showEvent.addEventListener(() => this.startUpdates());
        this.visibilityService.hideEvent.addEventListener(() => this.stopUpdates());
        
        this._setupVRPresentChangeHandler();
    }

    public _processContextFrameState(state:ContextFrameState) {
        const time = state.time;
        const contextService = this.contextService;
        const entities = state.entities;
        
        // stage
        const deviceStage = this.stage;
        const contextStage = contextService.stage;
        if (entities[contextStage.id] === undefined) {
            const contextStagePosition = contextStage.position as ConstantPositionProperty;
            const contextStageOrientation = contextStage.orientation as ConstantProperty;
            contextStagePosition.setValue(Cartesian3.ZERO, deviceStage);
            contextStageOrientation.setValue(Quaternion.IDENTITY);
        }

        // user
        const deviceUser = this.user;
        const contextUser = contextService.user;
        if (entities[contextUser.id] === undefined) {
            const userPositionValue = this._getEntityPositionInReferenceFrame(deviceUser, time, deviceStage, this._scratchCartesian);
            const userOrientationValue =  this._getEntityOrientationInReferenceFrame(deviceUser, time, deviceStage, this._scratchQuaternion);
            const contextUserPosition = contextUser.position as ConstantPositionProperty;
            const contextUserOrientation = contextUser.orientation as ConstantProperty;
            contextUserPosition.setValue(userPositionValue, contextStage);
            contextUserOrientation.setValue(userOrientationValue);
        }

        // view
        const contextView = contextService.view;
        if (entities[contextView.id] === undefined) {
            const contextViewPosition = contextView.position as ConstantPositionProperty;
            const contextViewOrientation = contextView.orientation as ConstantProperty;
            contextViewPosition.setValue(Cartesian3.ZERO, contextUser);
            contextViewOrientation.setValue(Quaternion.IDENTITY);
        }

        // floor
        if (entities[contextService.floor.id] === undefined) {
            const floorPosition = contextService.floor.position as ConstantPositionProperty;
            floorPosition.setValue(Cartesian3.ZERO, contextStage);
        }


        // If running within an older manager, we have to set the stage based on the user pose. 
        if (this.sessionService.manager.isConnected && this.sessionService.manager.version[0] === 0) {
            const userPositionFixed = this._getEntityPositionInReferenceFrame(
                contextUser,
                time,
                ReferenceFrame.FIXED,
                this._scratchCartesian
            );
            if (userPositionFixed) {
                const enuToFixedFrameTransform = Transforms.eastNorthUpToFixedFrame(userPositionFixed, undefined, this._scratchMatrix4);
                const enuRotationMatrix = Matrix4.getRotation(enuToFixedFrameTransform, this._scratchMatrix3);
                const enuOrientation = Quaternion.fromRotationMatrix(enuRotationMatrix);
                (contextStage.position as ConstantPositionProperty).setValue(userPositionFixed, ReferenceFrame.FIXED);
                (contextStage.orientation as ConstantProperty).setValue(enuOrientation);
            }
        }
    }

    private _onDeviceState(deviceState:DeviceState) {
        this.deviceState = deviceState;


        const entities = deviceState.entities;
        const contextService = this.contextService;

        if (entities) for (const id in entities) {
            contextService.updateEntityFromSerializedState(id, entities[id]);
        }
    }

    private _updating = false;

    private _updateFrameState = () => {
        if (!this._updating) return;

        this.requestAnimationFrame(this._updateFrameState);

        const state = this.frameState = this.frameState || {};
        const time = state.time = JulianDate.now(state.time);
        state.screenOrientationDegrees = this.getScreenOrientationDegrees();

        const element = this.viewService.element;
        const viewport = state.viewport;
        viewport.x = 0;
        viewport.y = 0;
        viewport.width = element && element.clientWidth || 0;
        viewport.height = element && element.clientHeight || 0;
        viewport.renderHeightScaleFactor = 1;
        viewport.renderWidthScaleFactor = 1;
        
        this.onUpdateFrameState();

        const contextViewId = this.contextService.view.id;
        for (let i=0; i < state.subviews.length; i++) {
            const s = state.subviews[i];
            s.pose = this._getSerializedEntityState(this.getSubviewEntity(i), time, this.user);
            if (s.pose) s.pose.r = contextViewId;
        }

        this.frameStateEvent.raiseEvent(state);

        if (this.autoSubmitFrame && vrDisplay && vrDisplay.isPresenting) {
            vrDisplay.submitFrame();
        }
    };

    public getScreenOrientationDegrees() {
        return typeof window !== 'undefined' ? (screen['orientation'] && -screen['orientation'].angle) || -window.orientation || 0 : 0;
    }

    /**
     * Request an animation frame callback for the current view. 
     */
    public requestAnimationFrame:(callback:(timestamp:number)=>void)=>number = callback => {
        if (vrDisplay && this.isPresentingHMD) {
            return vrDisplay.requestAnimationFrame(callback);
        } else {
            return requestAnimationFrame(callback);
        }
    }

    public cancelAnimationFrame:(id:number)=>void = id => {
        if (vrDisplay && this.isPresentingHMD) {
            vrDisplay.cancelAnimationFrame(id);
        } else {
            cancelAnimationFrame(id);
        }
    }

    /**
     * Start emmitting frameState events
     */
    public startUpdates() : void {
        if (!this._updating) this.requestAnimationFrame(this._updateFrameState);
        this._updating = true;
        this.sessionService.manager.whenConnected().then(()=>{
            if (this.sessionService.manager.version[0] > 0) {
                this.sessionService.manager.send('ar.device.startUpdates');
            }
        });
    }

    /**
     * Stop emitting frameState events
     */
    public stopUpdates() : void {
        this._updating = false;
        this.sessionService.manager.whenConnected().then(()=>{
            if (this.sessionService.manager.version[0] > 0) {
                this.sessionService.manager.send('ar.device.stopUpdates');
            }
        });
    }

    protected onUpdateFrameState() {
        if (vrDisplay && this.isPresentingHMD) {
            this._updateForWebVR();
        } else {
            this._updateDefault();
        }
    }

    private _updateDefault() {
        this._updateUserDefault();

        const deviceState = this.deviceState;

        const frameState = this.frameState;
        frameState.suggestedUserHeight = deviceState.suggestedUserHeight;
        frameState.isPresentingHMD = deviceState.isPresentingHMD;
        frameState.geolocationDesired = deviceState.geolocationDesired;
        frameState.geolocationOptions = deviceState.geolocationOptions;
        frameState.strict = deviceState.strict;
        
        const viewport = frameState.viewport;
        if (deviceState.viewport) {
            CanvasViewport.clone(deviceState.viewport, viewport);
        }

        const subviews = frameState.subviews;
        if (deviceState.subviews) {
            SerializedSubviewList.clone(deviceState.subviews, subviews);
        } else {
            subviews.length = 1;
            const subview = subviews[0] || {};
  
            subview.type = SubviewType.SINGULAR;

            subview.viewport.x = 0;
            subview.viewport.y = 0;
            subview.viewport.width = viewport.width;
            subview.viewport.height = viewport.height;

            const aspect = viewport.width / viewport.height;
            const frustum = this._scratchFrustum;
            frustum.near = DEFAULT_NEAR_PLANE;
            frustum.far = DEFAULT_FAR_PLANE;
            frustum.fov = CesiumMath.PI_OVER_THREE;
            frustum.aspectRatio = isFinite(aspect) && aspect !== 0 ? aspect : 1;
            subview.projectionMatrix = Matrix4.clone(frustum.projectionMatrix, subview.projectionMatrix);

            const subviewEntity = this.getSubviewEntity(0);
            (subviewEntity.position as ConstantPositionProperty).setValue(Cartesian3.ZERO, this.user);
            (subviewEntity.orientation as ConstantProperty).setValue(Quaternion.IDENTITY);
        }
    }


    private _vrFrameData?:any;
    private _scratchQuaternion = new Quaternion;
    private _scratchQuaternion2 = new Quaternion;
    private _scratchMatrix3 = new Matrix3;
    private _scratchMatrix4 = new Matrix4;

    private _stageEUS = new Entity({
        position: new ConstantPositionProperty(Cartesian3.ZERO, this.stage),
        orientation: new ConstantProperty(Quaternion.fromAxisAngle(Cartesian3.UNIT_X, CesiumMath.PI_OVER_TWO))
    })

    /**
     * Defines the webvr standing space, positioned at the stage (EUS) frame by default. 
     */
    public vrStandingSpace = new Entity({
        position: new ConstantPositionProperty(Cartesian3.ZERO, this._stageEUS),
        orientation: new ConstantProperty(Quaternion.IDENTITY)
    });

	private _defaultLeftBounds = [ 0.0, 0.0, 0.5, 1.0 ];
	private _defaultRightBounds = [ 0.5, 0.0, 0.5, 1.0 ];

    private _updateForWebVR() {

        if (!vrDisplay) return;
        
        const frameState = this.frameState;
        frameState.strict = true;
       
        var leftEye = vrDisplay.getEyeParameters("left");
        var rightEye = vrDisplay.getEyeParameters("right");
        
        const viewport = frameState.viewport;
        viewport.renderWidthScaleFactor = 2 * Math.max(leftEye.renderWidth, rightEye.renderWidth) / viewport.width;
        viewport.renderHeightScaleFactor = Math.max(leftEye.renderHeight, rightEye.renderHeight) / viewport.height;

        const vrFrameData : VRFrameData = this._vrFrameData = 
            this._vrFrameData || new VRFrameData();
        if (!vrDisplay['getFrameData'](vrFrameData)) 
            return this.frameState;

        const layers = vrDisplay.getLayers();
        let leftBounds = layers[0].leftBounds;
        let rightBounds = layers[0].rightBounds;

        if ( layers.length ) {
            var layer = layers[ 0 ]!;
            leftBounds = layer.leftBounds && layer.leftBounds.length === 4 ? layer.leftBounds : this._defaultLeftBounds;
            rightBounds = layer.rightBounds && layer.rightBounds.length === 4 ? layer.rightBounds : this._defaultRightBounds;
        } else {
            leftBounds = this._defaultLeftBounds;
            rightBounds = this._defaultRightBounds;
        }
        
        const subviews = frameState.subviews = frameState.subviews || [];
        subviews.length = 2;

        const leftSubview = subviews[0] = subviews[0] || {};
        const rightSubview = subviews[1] = subviews[1] || {};
        leftSubview.type = SubviewType.LEFTEYE;
        rightSubview.type = SubviewType.RIGHTEYE;

        const leftViewport = leftSubview.viewport = leftSubview.viewport || <CanvasViewport>{};
        leftViewport.x = leftBounds[0] * viewport.width;
        leftViewport.y = leftBounds[1] * viewport.height;
        leftViewport.width = leftBounds[2] * viewport.width;
        leftViewport.height = leftBounds[3] * viewport.height;

        const rightViewport = rightSubview.viewport = rightSubview.viewport || <CanvasViewport>{};
        rightViewport.x = rightBounds[0] * viewport.width;
        rightViewport.y = rightBounds[1] * viewport.height;
        rightViewport.width = rightBounds[2] * viewport.width;
        rightViewport.height = rightBounds[3] * viewport.height;

        leftSubview.projectionMatrix = Matrix4.clone(
            <any>vrFrameData.leftProjectionMatrix, 
            leftSubview.projectionMatrix
        );
        rightSubview.projectionMatrix = Matrix4.clone(
            <any>vrFrameData.rightProjectionMatrix, 
            rightSubview.projectionMatrix
        );

        const sittingToStandingTransform = vrDisplay.stageParameters ? 
            <Matrix4><any> vrDisplay.stageParameters.sittingToStandingTransform :
            Matrix4.IDENTITY;

        const sittingToStandingRotation = Matrix4.getRotation(sittingToStandingTransform, this._scratchMatrix3);
        const sittingToStandingQuaternion = Quaternion.fromRotationMatrix(sittingToStandingRotation, this._scratchQuaternion)

        const user = this.user;
        const standingSpace = this.vrStandingSpace;

        const sittingUserPosition : Cartesian3|undefined = vrFrameData.pose.position ? 
            Cartesian3.unpack(<any>vrFrameData.pose.position, 0, this._scratchCartesian) : undefined;
        const standingUserPosition : Cartesian3|undefined = sittingUserPosition ? 
            Matrix4.multiplyByPoint(sittingToStandingTransform, sittingUserPosition, this._scratchCartesian) : undefined;
        const sittingUserOrientation : Quaternion|undefined = vrFrameData.pose.orientation ? 
            Quaternion.unpack(<any>vrFrameData.pose.orientation, 0, this._scratchQuaternion2) : undefined;
        const standingUserOrientation = sittingUserOrientation ? 
            Quaternion.multiply(sittingToStandingQuaternion, sittingUserOrientation, this._scratchQuaternion) : undefined;

        if (!user.position) user.position = new ConstantPositionProperty();
        if (!user.orientation) user.orientation = new ConstantProperty();
        (user.position as ConstantPositionProperty).setValue(standingUserPosition, standingSpace);
        (user.orientation as ConstantProperty).setValue(standingUserOrientation);

        if (standingUserPosition && standingUserOrientation) {
            const leftEyeSittingSpaceTransform = Matrix4.inverseTransformation(
                <any>vrFrameData.leftViewMatrix, 
                this._scratchMatrix4
            );
            const leftEyeStandingSpaceTransform = Matrix4.multiplyTransformation(
                sittingToStandingTransform, 
                leftEyeSittingSpaceTransform, 
                this._scratchMatrix4
            );
            
            const leftEye = this.getSubviewEntity(0);
            const leftEyePosition = Matrix4.getTranslation(leftEyeStandingSpaceTransform, this._scratchCartesian);
            const leftEyeRotation = Matrix4.getRotation(leftEyeStandingSpaceTransform, this._scratchMatrix3);
            const leftEyeOrientation = Quaternion.fromRotationMatrix(leftEyeRotation, this._scratchQuaternion);
            (leftEye.position as ConstantPositionProperty).setValue(leftEyePosition, standingSpace);
            (leftEye.orientation as ConstantProperty).setValue(leftEyeOrientation);
            
            const rightEyeSittingSpaceTransform = Matrix4.inverseTransformation(
                <any>vrFrameData.rightViewMatrix, 
                this._scratchMatrix4
            );
            const rightEyeStandingSpaceTransform = Matrix4.multiplyTransformation(
                sittingToStandingTransform,
                rightEyeSittingSpaceTransform,
                this._scratchMatrix4
            );
            
            const rightEye = this.getSubviewEntity(1);
            const rightEyePosition = Matrix4.getTranslation(rightEyeStandingSpaceTransform, this._scratchCartesian);
            const rightEyeRotation = Matrix4.getRotation(rightEyeStandingSpaceTransform, this._scratchMatrix3);
            const rightEyeOrientation = Quaternion.fromRotationMatrix(rightEyeRotation, this._scratchQuaternion);
            (rightEye.position as ConstantPositionProperty).setValue(rightEyePosition, standingSpace);
            (rightEye.orientation as ConstantProperty).setValue(rightEyeOrientation);
        }

        if (vrDisplay.displayName.match(/polyfill/g)) {
            // The polyfill does not support reporting an absolute orientation (yet), 
            // so fall back to the default orientation calculation
            (user.position as ConstantPositionProperty).setValue(undefined, undefined);
            (user.orientation as ConstantProperty).setValue(undefined);
            this._updateUserDefault();
        }
    }

    private _scratchFrameState:ContextFrameState = {
        time:<any>{},
        entities: {},
        viewport: <any>{},
        subviews: []
    }

    private _getSerializedEntityState = getSerializedEntityState;

    /**
     * Generate a frame state for the ContextService.
     * 
     * @param time 
     * @param viewport 
     * @param subviewList 
     * @param user 
     * @param entityOptions 
     */
    public createContextFrameState(
        time:JulianDate,
        viewport:CanvasViewport,
        subviewList:SerializedSubviewList,
        options?: {overrideStage?:boolean, overrideUser?:boolean, overrideView?:boolean, floorOffset?:number}
    ) : ContextFrameState {

        // TODO: In certain cases (webvr?), we may want to disallow the reality from overriding the user entity 

        for (const s of subviewList) {
            if (!isFinite(s.projectionMatrix[0]))
                throw new Error('Invalid projection matrix (contains non-finite values)');
        }

        const frameState:ContextFrameState = this._scratchFrameState;
        frameState.time = JulianDate.clone(time, frameState.time);
        frameState.viewport = CanvasViewport.clone(viewport, frameState.viewport);
        frameState.subviews = SerializedSubviewList.clone(subviewList, frameState.subviews);

        const contextService = this.contextService;
        const getEntityState = this._getSerializedEntityState;

        // stage
        const stage = contextService.stage;
        if (options && options.overrideStage) {
            frameState.entities[stage.id] = getEntityState(stage, time, undefined);
        } else {
            delete frameState.entities[stage.id];
        }

        // user
        const user = contextService.user;
        if (options && options.overrideUser) {
            frameState.entities[user.id] = getEntityState(user, time, stage);
        } else {
            delete frameState.entities[user.id];
        }

        // view
        const view = contextService.view;
        if (options && options.overrideView) {
            frameState.entities[view.id] = getEntityState(view, time, user);
        } else {
            delete frameState.entities[view.id];
        }

        // floor
        const floorOffset = options && options.floorOffset || 0;
        const floor = this.contextService.floor;
        (floor.position as ConstantPositionProperty).setValue(Cartesian3.fromElements(0,0,floorOffset, this._scratchCartesian), stage);
        if (floorOffset !== 0) {
            frameState.entities[contextService.floor.id] = getEntityState(floor, time, stage);
        }
        
        return frameState;
    }

    getSubviewEntity(index:number) {
        const subviewEntity = this.contextService.entities.getOrCreateEntity('ar.device.view_'+index);
        if (!subviewEntity.position) {
            subviewEntity.position = new ConstantPositionProperty();
        }
        if (!subviewEntity.orientation) {
            subviewEntity.orientation = new ConstantProperty();
        }
        return subviewEntity;
    }

    subscribeGeolocation(options?:GeolocationOptions, session=this.sessionService.manager) : Promise<void> {
        if (session.version[0] > 0) 
            session.send('ar.device.setGeolocationOptions', {options});
        return this.contextService.subscribe(this.stage.id, session).then(()=>{});
    }

    unsubscribeGeolocation(session=this.sessionService.manager) : void {
        this.contextService.unsubscribe(this.stage.id, session);
    }

    get isPresentingHMD() : boolean {
        return this.frameState.isPresentingHMD;
    }

    requestPresentHMD() : Promise<void> {
        return this.sessionService.manager.request('ar.device.requestPresentHMD').then(()=>{
            this.frameState.isPresentingHMD = true; 
        });
    }

    exitPresentHMD() : Promise<void> {
        return this.sessionService.manager.request('ar.device.exitPresentHMD').then(()=>{
            this.frameState.isPresentingHMD = false;
        });
    }

    private _deviceOrientationListener;
    private _deviceOrientation:Quaternion|undefined;
    private _deviceOrientationHeadingAccuracy:number|undefined;

    private _updateUserDefault() {
        
        const deviceUser = this.user;
        const deviceStage = this.stage;
        const deviceOrientation = this._deviceOrientation;

        this._tryOrientationUpdates();

        if (!deviceOrientation) {
            deviceUser.position = undefined;
            deviceUser.orientation = undefined;
            return;
        }

        const screenOrientation = 
            Quaternion.fromAxisAngle(
                Cartesian3.UNIT_Z, 
                this.frameState.screenOrientationDegrees * CesiumMath.RADIANS_PER_DEGREE, 
                this._scratchQuaternion
            );

        if (!deviceUser.position) deviceUser.position = new ConstantPositionProperty();
        if (!deviceUser.orientation) deviceUser.orientation = new ConstantProperty();
        
        (deviceUser.position as ConstantPositionProperty).setValue(
            Cartesian3.fromElements(0,0,this.deviceState.suggestedUserHeight, this._scratchCartesian), 
            deviceStage
        );

        (deviceUser.orientation as ConstantProperty).setValue(
            Quaternion.multiply(
                deviceOrientation, 
                screenOrientation,
                this._scratchQuaternion
            )
        );

        deviceUser['meta'] = deviceUser['meta'] || {};
        deviceUser['meta'].geoHeadingAccuracy = this._deviceOrientationHeadingAccuracy;
    }

    private _tryOrientationUpdates() : void {
        if (typeof window == 'undefined' || !window.addEventListener) 
            return;

        if (defined(this._deviceOrientationListener)) return;

        let headingDrift = 0;
        let alphaOffset:number|undefined = undefined;

        this._deviceOrientationListener = (e: DeviceOrientationEvent) => {

            let alphaDegrees = e.alpha;
            let webkitCompassHeading: number = e['webkitCompassHeading'];
            const webkitCompassAccuracy: number = +e['webkitCompassAccuracy'];

            if (!defined(alphaDegrees)) {
                return;
            }

            if (e.absolute) {
                alphaOffset = 0;
            }

            // when the phone is almost updside down, webkit flips the compass heading 
            // (not documented anywhere, annoyingly)
            // if (e.beta >= 130 || e.beta <= -130) webkitCompassHeading = undefined;

            this._deviceOrientationHeadingAccuracy = webkitCompassAccuracy > 0 ? webkitCompassAccuracy : undefined;

            if ((!defined(alphaOffset) || Math.abs(headingDrift) > 5) &&
                defined(webkitCompassHeading) &&
                webkitCompassAccuracy >= 0 &&
                webkitCompassAccuracy < 80 &&
                webkitCompassHeading >= 0) {
                if (!defined(alphaOffset)) {
                    alphaOffset = -webkitCompassHeading;
                } else {
                    alphaOffset -= headingDrift;
                }
            }

            if (!defined(alphaOffset) || 
                !defined(e.alpha) || 
                !defined(e.beta) || 
                !defined(e.gamma)) 
                return;

            const alpha = CesiumMath.RADIANS_PER_DEGREE * (e.alpha + alphaOffset || -webkitCompassHeading || 0);
            const beta = CesiumMath.RADIANS_PER_DEGREE * e.beta;
            const gamma = CesiumMath.RADIANS_PER_DEGREE * e.gamma;

            const alphaQuat = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, alpha, this._scratchQuaternion);
            const betaQuat = Quaternion.fromAxisAngle(Cartesian3.UNIT_X, beta, this._scratchQuaternion2);
            const alphaBetaQuat = Quaternion.multiply(alphaQuat, betaQuat, this._scratchQuaternion);
            const gammaQuat = Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, gamma, this._scratchQuaternion2);
            const alphaBetaGammaQuat = Quaternion.multiply(alphaBetaQuat, gammaQuat, this._scratchQuaternion);

            this._deviceOrientation = Quaternion.clone(alphaBetaGammaQuat, this._deviceOrientation);
            this._deviceOrientationHeadingAccuracy = webkitCompassAccuracy;

            // TODO: fix heading drift calculation (heading should match webkitCompassHeading)
            // if (defined(webkitCompassHeading)) {
            //     const q = alphaBetaGammaQuat//utils.getEntityOrientationInReferenceFrame(this.interfaceEntity, JulianDate.now(), this.locationEntity, this._scratchQuaternion1);
            //     var heading = -Math.atan2(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z));
            //     if (heading < 0) heading += 2*Math.PI;
            //     const {swing,twist} = swingTwistDecomposition(alphaBetaGammaQuat, Cartesian3.UNIT_Z);
            //     const twistAngle = 2 * Math.acos(twist.w);
            //     console.log(twist.w + ' ' + twistAngle * CesiumMath.DEGREES_PER_RADIAN + '\n' + webkitCompassHeading);
            //     // this._headingDrift = webkitCompassHeading - heading * CesiumMath.DEGREES_PER_RADIAN;
            // }
        }

        if ('ondeviceorientationabsolute' in window) {
            window.addEventListener('deviceorientationabsolute', this._deviceOrientationListener)
        } else if ('ondeviceorientation' in window) {
            window.addEventListener('deviceorientation', this._deviceOrientationListener)
        }
    }

    private _setupVRPresentChangeHandler() {
        if (typeof window !=='undefined' && window.addEventListener) {

            this.viewService.viewportModeChangeEvent.addEventListener((mode)=>{
                if (mode === ViewportMode.PAGE && vrDisplay && vrDisplay.displayName.match(/Cardboard/g)) 
                    this.exitPresentHMD();
            });

            let currentCanvas:HTMLElement|undefined;
            let previousPresentationMode:ViewportMode;

            const handleVRDisplayPresentChange = (e) => {
                const viewService = this.viewService;
                const display:VRDisplay|undefined = e.display || e.detail.vrdisplay || e.detail.display;
                if (display) {
                    if (display.isPresenting) {
                        vrDisplay = display;
                        if (display.displayName.match(/Cardboard/g)) {
                            currentCanvas = display.getLayers()[0].source;
                            if (currentCanvas) currentCanvas.classList.add('argon-interactive');
                            previousPresentationMode = viewService.viewportMode;
                            viewService.desiredViewportMode = ViewportMode.IMMERSIVE;
                        }
                    } else {
                        vrDisplay = undefined;
                        if (currentCanvas && display.displayName.match(/Cardboard/g)) {
                            currentCanvas.classList.remove('argon-interactive');
                            currentCanvas = undefined;
                            viewService.desiredViewportMode = previousPresentationMode;
                        }
                    }
                }
            }
            window.addEventListener('vrdisplaypresentchange', handleVRDisplayPresentChange);
        }
    }

}

@autoinject()
export class DeviceServiceProvider {

    private _subscribers = new Set<SessionPort>();
    
    constructor(
        protected sessionService:SessionService,
        protected deviceService:DeviceService,
        protected contextService:ContextService,
        protected viewService:ViewService,
        protected contextServiceProvider:ContextServiceProvider,
    ) {
        this.contextServiceProvider.publishingReferenceFrameMap.set(deviceService.stage.id, ReferenceFrame.FIXED);
        this.contextServiceProvider.publishingReferenceFrameMap.set(deviceService.user.id, deviceService.stage.id);
        
        this.sessionService.connectEvent.addEventListener((session)=>{
            // backwards compat pre-v1.1.8
            session.on['ar.device.requestFrameState'] = () => {
                this._subscribers.add(session);
                return new Promise((resolve) => {
                    const remove = this.deviceService.frameStateEvent.addEventListener((frameState)=>{
                        resolve(frameState)
                        remove();
                    });
                });
            }

            session.on['ar.device.startUpdates'] = () => {
                this._subscribers.add(session);
            }

            session.on['ar.device.stopUpdates'] = () => {
                this._subscribers.delete(session);
            }

            session.on['ar.device.setGeolocationOptions'] = (options) => {
                this._handleSetGeolocationOptions(session, options);
            }

            session.on['ar.device.requestPresentHMD'] = () => {
                return this.handleRequestPresentHMD(session).then(()=>{
                    this.deviceService.deviceState.isPresentingHMD = true;
                    this.publishDeviceState();
                })
            }

            session.on['ar.device.exitPresentHMD'] = () => {
                return this.handleExitPresentHMD(session).then(()=>{
                    this.deviceService.deviceState.isPresentingHMD = false;
                    this.publishDeviceState();
                })
            }
        });

        this.contextServiceProvider.subscribersChangeEvent.addEventListener(({id})=>{
            if (this.deviceService.stage.id === id || this.contextService.stage.id === id)
                this._checkDeviceGeolocationSubscribers();
        });

        if (typeof window !== 'undefined' && window.addEventListener) {
            const orientationChangeListener = ()=>{
                this.publishDeviceState();
            }
            window.addEventListener('orientationchange', orientationChangeListener);
            sessionService.manager.closeEvent.addEventListener(()=>{
                window.removeEventListener('orientationchange', orientationChangeListener);
            })
        }
    }

    protected handleRequestPresentHMD(session:SessionPort) : Promise<void> {
        if (vrDisplay) {
            const element = this.viewService.element;
            const layers:VRLayer&{}[] = [];
            layers[0] = {source:element.querySelector('canvas') || <HTMLCanvasElement>element.lastElementChild};
            return vrDisplay.requestPresent(layers).catch((e)=>{
                throw e;
            });
        }
        throw new Error('No HMD available');
    }
    
    protected handleExitPresentHMD(session:SessionPort) : Promise<void> {
        if (vrDisplay) {
            return vrDisplay.exitPresent();
        }
        return Promise.resolve();
    }

    public publishDeviceState() {
        const deviceState = this.deviceService.deviceState;
        
        deviceState.geolocationDesired = this.contextServiceProvider.geolocationDesired;
        deviceState.geolocationOptions = this.contextServiceProvider.desiredGeolocationOptions;
        deviceState.suggestedUserHeight = this.suggestedUserHeight;

        this.onUpdateDeviceState(this.deviceService.deviceState);

        // send device state to each subscribed session 
        const time = JulianDate.now();
        this._subscribers.forEach((s)=>{
            if (s.version[0] > 0) {
                for (const k in deviceState.entities) {delete deviceState.entities[k]};
                this.contextServiceProvider.fillEntityStateMapForSession(s, time, deviceState.entities);
                s.send('ar.device.state', deviceState);
            }
        });
    }

    public defaultUserHeight = AVERAGE_EYE_HEIGHT;

    public get suggestedUserHeight() {
        return this.deviceService.isPresentingHMD ? this.defaultUserHeight : this.defaultUserHeight/2;
    }

    protected onUpdateDeviceState(deviceState:DeviceState) {
        deviceState.viewport = undefined;
        deviceState.subviews = undefined;
        deviceState.strict = false;
    }

    private _currentGeolocationOptions?:GeolocationOptions;
    private _targetGeolocationOptions:GeolocationOptions = {};
    private _sessionGeolocationOptions = new Map<SessionPort, GeolocationOptions|undefined>();

    private _checkDeviceGeolocationSubscribers() {
        const subscribers = this.contextServiceProvider.subscribersByEntityId.get(this.deviceService.stage.id);
        if (subscribers && subscribers.size > 0) {
            this._updateTargetGeolocationOptions();
            if (JSON.stringify(this._targetGeolocationOptions) !== JSON.stringify(this._currentGeolocationOptions)) {
                this._currentGeolocationOptions = this._targetGeolocationOptions;
                this.onStopGeolocationUpdates();
                this.onStartGeolocationUpdates(this._targetGeolocationOptions);
            }
        } else {
            this.onStopGeolocationUpdates();
            this._currentGeolocationOptions = undefined;
        }
        this.publishDeviceState();
    }

    private _handleSetGeolocationOptions(session:SessionPort, options:GeolocationOptions) {
        this._sessionGeolocationOptions.set(session, options);
        session.closeEvent.addEventListener(()=>{
            this._sessionGeolocationOptions.delete(session);
        });
    }

    private _updateTargetGeolocationOptions() {
        const reducedOptions:GeolocationOptions = {};
        this._sessionGeolocationOptions.forEach((options, session)=>{
            reducedOptions.enableHighAccuracy = 
                reducedOptions.enableHighAccuracy || (options && options.enableHighAccuracy) || false;
        });
        if (this._targetGeolocationOptions.enableHighAccuracy !== reducedOptions.enableHighAccuracy) {
            this._targetGeolocationOptions = reducedOptions;
        }
        this.publishDeviceState();
    }

    protected _scratchCartesianLocalOrigin = new Cartesian3;
    protected _scratchQuaternionLocalOrigin = new Quaternion;
    protected _scratchFrustum = new PerspectiveFrustum();

    protected configureStage(
            longitude?:number,
            latitude?:number,
            altitude?:number,
            geoHorizontalAccuracy?:number,
            geoVerticalAccuracy?:number) {

        const stage = this.deviceService.stage;

        if (defined(longitude) && defined(latitude)) {
            // TODO: fallback on https://cesiumjs.org/Cesium/Build/Documentation/sampleTerrain.html for height
            const height = defined(altitude) ? altitude : 0;

            const fixedPosition = Cartesian3.fromDegrees(longitude, latitude, height, undefined, this._scratchCartesianLocalOrigin);
            const enuOrientation = Transforms.headingPitchRollQuaternion(fixedPosition, 0,0,0, undefined, this._scratchQuaternionLocalOrigin);

            stage.position = stage.position || new ConstantPositionProperty();
            stage.orientation = stage.orientation || new ConstantProperty();

            (stage.position as ConstantPositionProperty).setValue(
                fixedPosition,
                ReferenceFrame.FIXED
            );

            (stage.orientation as ConstantProperty).setValue(
                enuOrientation
            );

            stage['meta'] = {
                geoHorizontalAccuracy,
                geoVerticalAccuracy
            };
        } else {
            stage.position = undefined;
            stage.orientation = undefined;
            stage['meta'] = undefined;
        }
    }

    private _geolocationWatchId?:number;

    /**
     * Overridable. Should call setGeolocation when new geolocation is available 
     */
    protected onStartGeolocationUpdates(options:GeolocationOptions) : void {
        if (typeof navigator == 'undefined' || !navigator.geolocation)
            throw new Error('Unable to start geolocation updates');
        if (!defined(this._geolocationWatchId)) {
            this._geolocationWatchId = navigator.geolocation.watchPosition((pos) => {
                this.configureStage(
                    pos.coords.longitude, 
                    pos.coords.latitude, 
                    pos.coords.altitude || 0, 
                    (pos.coords.accuracy > 0) ? pos.coords.accuracy : undefined,
                    pos.coords.altitudeAccuracy || undefined
                );
            }, (e)=>{
                console.warn('Unable to start geolocation updates: ' + e.message);
            }, options);
        }
    }

    /**
     * Overridable.
     */
    protected onStopGeolocationUpdates() : void {
        if (typeof navigator !== 'undefined' && defined(this._geolocationWatchId)) {
            navigator.geolocation.clearWatch(this._geolocationWatchId);
            this._geolocationWatchId = undefined;
        }
    }

}

declare class VRFrameData {
    timestamp:number;

    leftProjectionMatrix:Float32Array;
    leftViewMatrix:Float32Array;

    rightProjectionMatrix:Float32Array;
    rightViewMatrix:Float32Array;

    pose:VRPose;
}